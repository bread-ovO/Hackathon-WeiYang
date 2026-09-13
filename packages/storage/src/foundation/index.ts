import Database from 'better-sqlite3'
import type { Health } from '@memo/contracts/foundation'
import { pauseCodes } from '@memo/contracts/foundation'
import { TOKENIZER_VERSION } from '@memo/application'
import { migrate, DATABASE_VERSION } from './migrations'
import {
  makeContext,
  validateLimits,
  type StoreOptions,
  type Limits,
  type PauseCode,
} from './context'
import { ingestion } from './ingestion'
import { taskRepository } from './tasks'
import { jobRepository } from './jobs'
import { searchRepository, isSearchReady } from './search'
import { identityRepository } from './identities'
export { DATABASE_VERSION } from './migrations'
export { DEFAULT_LIMITS, type Limits, type StoreOptions } from './context'
export type { SourceRegistration } from './ingestion'
export type { SearchQuery, SearchResult } from './search'

export function openFoundationStore(path: string, options: StoreOptions = {}) {
  const db = new Database(path)
  try {
    if (
      (db.pragma('user_version', { simple: true }) as number) > DATABASE_VERSION
    )
      throw new Error('DATABASE_TOO_NEW')
    // Production also has a v2 migration; its version number alone is ambiguous.
    if ((db.pragma('user_version', { simple: true }) as number) === 2 &&
        !(db.pragma('table_info(source_events)') as { name: string }[]).some(column => column.name === 'envelope'))
      throw new Error('INCOMPATIBLE_DATABASE_FORMAT')
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.pragma('busy_timeout = 3000')
    migrate(db, path, options.fault ?? (() => {}), options.now ?? Date.now)
    if (options.sqlitePageLimit !== undefined) {
      if (
        !Number.isSafeInteger(options.sqlitePageLimit) ||
        options.sqlitePageLimit < 1
      )
        throw new Error('INVALID_PAGE_LIMIT')
      db.pragma('max_page_count = ' + options.sqlitePageLimit)
    }
    const ctx = makeContext(db, path, options)
    const search = searchRepository(ctx)
    const ready = (
      db
        .prepare("SELECT value FROM store_meta WHERE key='search_ready'")
        .get() as { value: string }
    ).value
    const tokenizer = db
      .prepare("SELECT value FROM store_meta WHERE key='tokenizer_version'")
      .get() as { value: string } | undefined
    if (ready !== '1' || tokenizer?.value !== TOKENIZER_VERSION) {
      try {
        search.rebuildSearch()
      } catch {
        ctx.pauses.set('search', 'STORAGE_ERROR')
      }
    }
    let pipelines: readonly string[] = []
    return {
      ...ingestion(ctx),
      ...taskRepository(ctx),
      ...jobRepository(ctx),
      ...search,
      ...identityRepository(ctx),
      setAvailablePipelines(values: readonly string[]) {
        pipelines = [...values]
      },
      setLimits(input: Partial<Limits>) {
        if (Object.keys(input).some((k) => !Object.hasOwn(ctx.limits, k)))
          throw new Error('INVALID_LIMITS')
        const next = { ...ctx.limits, ...input }
        validateLimits(next)
        // This named host-only operation can raise a quota that is preventing ordinary writes.
        db.prepare(
          "INSERT INTO store_meta VALUES('limits',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(JSON.stringify(next))
        Object.assign(ctx.limits, next)
      },
      checkpointWal() {
        const row = (
          db.pragma('wal_checkpoint(PASSIVE)') as {
            busy: number
            log: number
            checkpointed: number
          }[]
        )[0]!
        return {
          busy: row.busy,
          logPages: row.log,
          checkpointedPages: row.checkpointed,
        }
      },
      health(): Health {
        const state = ctx.resourceState(),
          depth = ctx.depth()
        if (depth <= ctx.limits.queueLow) ctx.pauses.delete('queue')
        if (depth >= ctx.limits.queueHigh)
          ctx.pauses.set('queue', 'QUEUE_LIMIT')
        const count = (sql: string) =>
          (db.prepare(sql).get() as { n: number }).n
        const pauses: Health['pauses'] = [...ctx.pauses].map(([key, code]) => ({
          sourceId: key.startsWith('source:') ? key.slice(7) : null,
          code,
        }))
        const sources = db
          .prepare(
            'SELECT id,active,pause_code FROM source_instances ORDER BY id LIMIT 100',
          )
          .all() as {
          id: string
          active: number
          pause_code: PauseCode | null
        }[]
        for (const s of sources)
          if (!s.active || s.pause_code)
            pauses.push({
              sourceId: s.id,
              code: s.active ? s.pause_code! : 'SOURCE_DISABLED',
            })
        const stoppedJobs = db
          .prepare(
            "SELECT DISTINCT e.source_id,j.error_code FROM jobs j JOIN source_events e ON e.id=j.event_id WHERE j.state='paused' LIMIT 100",
          )
          .all() as { source_id: string; error_code: string }[]
        for (const j of stoppedJobs)
          pauses.push({
            sourceId: j.source_id,
            code: pauseCodes.includes(j.error_code as PauseCode)
              ? (j.error_code as PauseCode)
              : 'SOURCE_PAUSED',
          })
        const waiting = db
          .prepare(
            "SELECT DISTINCT pipeline_version FROM jobs WHERE state IN ('pending','retry_wait','paused')",
          )
          .all() as { pipeline_version: string }[]
        if (waiting.some((j) => !pipelines.includes(j.pipeline_version)))
          pauses.push({ sourceId: null, code: 'NO_HANDLER' })
        const oldest = db
          .prepare(
            "SELECT MIN(created_at) AS oldest FROM jobs WHERE state IN ('pending','running','retry_wait','paused')",
          )
          .get() as { oldest: string | null }
        const running = count(
          "SELECT count(*) AS n FROM jobs WHERE state='running'",
        )
        return {
          status: 'ready',
          schemaVersion: DATABASE_VERSION,
          sqliteVersion: (
            db.prepare('SELECT sqlite_version() AS version').get() as {
              version: string
            }
          ).version,
          eventCount: count('SELECT count(*) AS n FROM source_events'),
          jobCount: count('SELECT count(*) AS n FROM jobs'),
          processingStatus: pauses.length
            ? 'paused'
            : running
              ? 'running'
              : 'idle',
          searchReady: isSearchReady(ctx),
          queue: {
            depth,
            running,
            dead: count("SELECT count(*) AS n FROM jobs WHERE state='dead'"),
            oldestAgeMs: oldest.oldest
              ? Math.max(0, ctx.now() - Date.parse(oldest.oldest))
              : 0,
          },
          resources: {
            usedBytes: Math.floor(state.usedBytes),
            availableBytes:
              state.availableBytes === null
                ? null
                : Math.floor(state.availableBytes),
            maxBytes: ctx.limits.diskBytes,
            queueHigh: ctx.limits.queueHigh,
            queueLow: ctx.limits.queueLow,
          },
          pauses: [
            ...new Map(pauses.map((p) => [JSON.stringify(p), p])).values(),
          ].slice(0, 100),
        }
      },
      close() {
        db.close()
      },
    }
  } catch (error) {
    db.close()
    throw error
  }
}
export type FoundationStore = ReturnType<typeof openFoundationStore>

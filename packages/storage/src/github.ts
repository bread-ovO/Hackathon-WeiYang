import {
  parseGithubAccountCursor,
  parseGithubAccountObservation,
} from '@memo/contracts'
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { parseContextTimestamp } from '@memo/domain'
import { randomUUID } from 'node:crypto'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'

export const githubFailureCodes = [
  'GITHUB_REQUEST_FAILED',
  'GITHUB_RATE_LIMITED',
  'GITHUB_AUTH_FAILED',
  'GITHUB_REPOSITORY_CHANGED',
  'GITHUB_INVALID_RESPONSE',
  'GITHUB_CREDENTIAL_UNAVAILABLE',
  'INGESTION_QUEUE_LIMIT',
  'INGESTION_DATABASE_LIMIT',
  'INGESTION_DISK_LOW',
  'INGESTION_PROBE_UNAVAILABLE',
] as const
export type GithubFailureCode = (typeof githubFailureCodes)[number]
export interface GithubConnection {
  mode?: 'repository' | 'account'
  errorScope?: string | null
  id: string
  projectId: string
  owner: string
  repo: string
  repositoryId: number
  credentialId: string
  grantVersion: number
  status: 'active' | 'paused' | 'revoked' | 'error'
  nextPollAt: number
  lastSuccessAt: string | null
  errorCode: GithubFailureCode | null
  failureCount: number
  eventCount: number
}
export interface GithubAuthorized extends GithubConnection {
  pollVersion: number
  cursor: string
  enabled: boolean
  revoked: boolean
}
export interface GithubAuthorizeInput {
  mode?: 'repository' | 'account'
  projectId: string
  owner: string
  repo: string
  repositoryId: number
  credentialId: string
}
export interface GithubBatchInput {
  id: string
  expectedGrantVersion: number
  expectedPollVersion: number
  expectedCursor: string
  events: SourceEvent[]
  nextCursor: string
  nextPollAt: number
}
export interface GithubFailureInput {
  errorScope?: string
  id: string
  expectedGrantVersion: number
  expectedPollVersion: number
  expectedCursor: string
  errorCode: GithubFailureCode
  nextPollAt: number
}
const invalid = (): never => {
  throw Error('GITHUB_INVALID_INPUT')
}
function text(v: unknown, max = 256): asserts v is string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > max ||
    /[\u0000-\u001f\u007f]/u.test(v)
  )
    invalid()
}
function integer(v: unknown, min = 0): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) invalid()
}
function cursor(v: unknown): asserts v is string {
  if (typeof v === 'string' && v.startsWith('{')) {
    parseGithubAccountCursor(v)
    return
  }
  if (
    typeof v !== 'string' ||
    (v !== '' && (!/^[1-9][0-9]{0,4}$/.test(v) || Number(v) > 10000))
  )
    invalid()
}
const summary = `SELECT g.error_scope AS errorScope,g.mode,g.source_id AS id,g.project_id AS projectId,g.owner,g.repo,g.repository_id AS repositoryId,g.credential_id AS credentialId,g.grant_version AS grantVersion,g.next_poll_at AS nextPollAt,g.last_success_at AS lastSuccessAt,g.error_code AS errorCode,g.failure_count AS failureCount,CASE WHEN g.revoked=1 THEN 'revoked' WHEN g.enabled=0 THEN 'paused' WHEN g.error_code IS NOT NULL THEN 'error' ELSE 'active' END AS status,(SELECT count(*) FROM source_events e JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=g.project_id WHERE e.source_id=g.source_id) AS eventCount FROM github_connections g`
export function migrateGithub(db: Database.Database) {
  db.transaction(() =>
    db.exec(
      `CREATE TABLE github_connections(source_id TEXT PRIMARY KEY REFERENCES source_instances(id),project_id TEXT NOT NULL REFERENCES projects(id),owner TEXT NOT NULL,repo TEXT NOT NULL,repository_id INTEGER NOT NULL CHECK(repository_id>0),credential_id TEXT NOT NULL,grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version>0 AND grant_version<=9007199254740991),poll_version INTEGER NOT NULL DEFAULT 1 CHECK(poll_version>0 AND poll_version<=9007199254740991),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),next_poll_at INTEGER NOT NULL DEFAULT 0 CHECK(next_poll_at>=0),last_success_at TEXT,error_code TEXT CHECK(error_code IS NULL OR error_code IN (${githubFailureCodes.map((c) => `'${c}'`).join(',')})),failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0));CREATE TABLE github_credential_cooldowns(credential_id TEXT PRIMARY KEY,not_before INTEGER NOT NULL CHECK(not_before>=0 AND not_before<=8640000000000000),failure_count INTEGER NOT NULL CHECK(failure_count>=1 AND failure_count<=1000000));CREATE UNIQUE INDEX github_active_repo ON github_connections(project_id,owner,repo) WHERE revoked=0;PRAGMA user_version=12;`,
    ),
  )()
}
export function migrateGithubAccount(db: Database.Database) {
  db.transaction(() =>
    db.exec(
      "ALTER TABLE github_connections ADD COLUMN mode TEXT NOT NULL DEFAULT 'repository' CHECK(mode IN ('repository','account'));ALTER TABLE github_connections ADD COLUMN error_scope TEXT;PRAGMA user_version=20;",
    ),
  )()
}
export function createGithub(
  db: Database.Database,
  receive: (event: SourceEvent, cursor: string) => { inserted: boolean },
  observe: (projectId: string, eventId: number) => void,
) {
  function get(id: string): GithubConnection {
    text(id)
    const row = db.prepare(`${summary} WHERE g.source_id=?`).get(id) as
      | GithubConnection
      | undefined
    if (!row) throw Error('GITHUB_NOT_FOUND')
    return row
  }
  function getAuthorized(id: string): GithubAuthorized {
    const connection = get(id)
    const row = db
      .prepare(
        'SELECT s.cursor,g.enabled,g.revoked,g.poll_version AS pollVersion FROM github_connections g JOIN source_instances s ON s.id=g.source_id WHERE g.source_id=?',
      )
      .get(id) as {
      cursor: string
      enabled: number
      revoked: number
      pollVersion: number
    }
    return {
      ...connection,
      cursor: row.cursor,
      pollVersion: row.pollVersion,
      enabled: !!row.enabled,
      revoked: !!row.revoked,
    }
  }
  function check(i: {
    id: string
    expectedGrantVersion: number
    expectedPollVersion: number
    expectedCursor: string
  }) {
    integer(i.expectedGrantVersion, 1)
    integer(i.expectedPollVersion, 1)
    cursor(i.expectedCursor)
    const g = getAuthorized(i.id)
    if (g.grantVersion !== i.expectedGrantVersion)
      throw Error('GITHUB_GRANT_CHANGED')
    if (g.pollVersion !== i.expectedPollVersion)
      throw Error('GITHUB_POLL_CHANGED')
    if (!g.enabled || g.revoked) throw Error('GITHUB_DISABLED')
    if (g.cursor !== i.expectedCursor) throw Error('GITHUB_CURSOR_CHANGED')
    return g
  }
  function validateEvent(input: unknown, g: GithubConnection): SourceEvent {
    const e = structuredClone(parseSourceEvent(input))
    if (
      e.sourceInstanceId !== g.id ||
      e.role !== 'tool' ||
      (e.operation ?? 'upsert') !== 'upsert'
    )
      invalid()
    if (g.mode === 'account') {
      const p = parseGithubAccountObservation(JSON.parse(e.text))
      if (
        e.externalId !==
          `repo:${p.repositoryId}:${p.objectKind}:${p.objectId}` ||
        e.occurredAt !== p.updatedAt ||
        e.revision !== createHash('sha256').update(e.text).digest('hex')
      )
        invalid()
      return e
    }
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(e.text)
    } catch {
      invalid()
    }
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.kind !== 'github-pull-request' ||
      payload.repository !== `${g.owner}/${g.repo}` ||
      payload.repositoryId !== g.repositoryId ||
      !Number.isSafeInteger(payload.number) ||
      Number(payload.number) < 1 ||
      e.externalId !== `pr:${payload.number}` ||
      typeof payload.url !== 'string' ||
      payload.url.toLowerCase() !==
        `https://github.com/${g.owner}/${g.repo}/pull/${payload.number}` ||
      !['open', 'closed', 'merged'].includes(String(payload.state))
    )
      throw Error('GITHUB_REPOSITORY_CHANGED')
    const keys = [
      'kind',
      'repository',
      'repositoryId',
      'number',
      'url',
      'state',
      'title',
      'draft',
      'updatedAt',
      'mergedAt',
      'base',
      'head',
      'createdAt',
      'closedAt',
    ]
    const bounded = (v: unknown, max: number): v is string =>
      typeof v === 'string' &&
      v.length > 0 &&
      v.length <= max &&
      !/[\u0000-\u001f\u007f]/u.test(v)
    const date = (v: unknown) => {
      try {
        parseContextTimestamp(v)
        return true
      } catch {
        return false
      }
    }
    const record = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v)
    const branch = (v: unknown, head: boolean) =>
      record(v) &&
      Object.keys(v).every((k) =>
        (head
          ? ['repository', 'ref', 'sha', 'label']
          : ['repository', 'ref', 'sha']
        ).includes(k),
      ) &&
      bounded(v.ref, 256) &&
      typeof v.sha === 'string' &&
      /^[a-f0-9]{40,64}$/i.test(v.sha) &&
      (head
        ? v.repository === null ||
          (typeof v.repository === 'string' &&
            /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/i.test(
              v.repository,
            ))
        : typeof v.repository === 'string' &&
          v.repository.toLowerCase() === `${g.owner}/${g.repo}`) &&
      (!head || bounded(v.label, 512))
    if (
      Object.keys(payload).some((k) => !keys.includes(k)) ||
      !bounded(payload.title, 2048) ||
      typeof payload.draft !== 'boolean' ||
      payload.updatedAt !== e.occurredAt ||
      !date(payload.updatedAt) ||
      !(payload.mergedAt === null || date(payload.mergedAt)) ||
      (payload.state === 'merged') !== (payload.mergedAt !== null) ||
      !branch(payload.base, false) ||
      !branch(payload.head, true) ||
      ('createdAt' in payload && !date(payload.createdAt)) ||
      ('closedAt' in payload &&
        payload.closedAt !== null &&
        !date(payload.closedAt))
    )
      throw Error('GITHUB_INVALID_RESPONSE')
    return e
  }
  function cooldownId(id: unknown): asserts id is string {
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      invalid()
  }
  function getCooldown(credentialId: string) {
    cooldownId(credentialId)
    return (
      (db
        .prepare(
          'SELECT not_before AS notBefore,failure_count AS failureCount FROM github_credential_cooldowns WHERE credential_id=?',
        )
        .get(credentialId) as
        | { notBefore: number; failureCount: number }
        | undefined) ?? { notBefore: 0, failureCount: 0 }
    )
  }
  return {
    getCooldown,
    recordCooldown: db.transaction(
      (input: { credentialId: string; notBefore: number }) => {
        cooldownId(input.credentialId)
        integer(input.notBefore)
        if (input.notBefore > 8640000000000000) invalid()
        db.prepare(
          'INSERT INTO github_credential_cooldowns VALUES(?,?,1) ON CONFLICT(credential_id) DO UPDATE SET not_before=MAX(not_before,excluded.not_before),failure_count=MIN(failure_count+1,1000000)',
        ).run(input.credentialId, input.notBefore)
        return getCooldown(input.credentialId)
      },
    ),
    list(): GithubConnection[] {
      return db
        .prepare(`${summary} ORDER BY g.source_id`)
        .all() as GithubConnection[]
    },
    getAuthorized,
    authorize: db.transaction((i: GithubAuthorizeInput) => {
      if (i.mode !== undefined && !['repository', 'account'].includes(i.mode))
        invalid()
      text(i.projectId)
      text(i.credentialId, 128)
      integer(i.repositoryId, 1)
      if (
        typeof i.owner !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(i.owner) ||
        typeof i.repo !== 'string' ||
        (i.mode === 'account'
          ? i.repo !== ''
          : !/^[a-z0-9_.-]{1,100}$/i.test(i.repo)) ||
        ['.', '..'].includes(i.repo)
      )
        invalid()
      const owner = i.owner.toLowerCase(),
        repo = i.repo.toLowerCase()
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(i.projectId))
        invalid()
      if (
        db
          .prepare(
            'SELECT 1 FROM github_connections WHERE project_id=? AND owner=? AND repo=? AND revoked=0',
          )
          .get(i.projectId, owner, repo)
      )
        throw Error('GITHUB_DUPLICATE')
      const id = randomUUID()
      db.prepare('INSERT INTO source_instances(id) VALUES(?)').run(id)
      db.prepare(
        'INSERT INTO github_connections(source_id,project_id,owner,repo,repository_id,credential_id,mode) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        i.projectId,
        owner,
        repo,
        i.repositoryId,
        i.credentialId,
        i.mode ?? 'repository',
      )
      return get(id)
    }),
    setEnabled: db.transaction((id: string, enabled: boolean) => {
      if (typeof enabled !== 'boolean') invalid()
      const g = getAuthorized(id)
      if (g.revoked) throw Error('GITHUB_DISABLED')
      if (g.enabled === enabled) return get(id)
      db.prepare(
        'UPDATE github_connections SET enabled=?,grant_version=grant_version+1,poll_version=poll_version+1 WHERE source_id=?',
      ).run(enabled ? 1 : 0, id)
      return get(id)
    }),
    revoke: db.transaction((id: string) => {
      const g = getAuthorized(id)
      if (!g.revoked)
        db.prepare(
          'UPDATE github_connections SET revoked=1,enabled=0,grant_version=grant_version+1,poll_version=poll_version+1 WHERE source_id=?',
        ).run(id)
      return get(id)
    }),
    receiveBatch: db.transaction((i: GithubBatchInput) => {
      cursor(i.nextCursor)
      integer(i.nextPollAt)
      const g = check(i)
      if (!Array.isArray(i.events) || i.events.length > 100) invalid()
      const events = i.events.map((e) => validateEvent(e, g))
      if (events.reduce((n, e) => n + e.text.length, 0) > 4 * 1024 * 1024)
        invalid()
      let inserted = 0
      for (const e of events) {
        if (receive(e, i.nextCursor).inserted) inserted++
        const row = db
          .prepare(
            'SELECT id FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
          )
          .get(g.id, e.externalId, e.revision) as { id: number }
        db.prepare(
          'INSERT INTO event_projects VALUES(?,?) ON CONFLICT DO NOTHING',
        ).run(g.projectId, row.id)
        observe(g.projectId, row.id)
      }
      db.prepare('UPDATE source_instances SET cursor=? WHERE id=?').run(
        i.nextCursor,
        g.id,
      )
      db.prepare(
        'UPDATE github_connections SET next_poll_at=?,last_success_at=?,error_code=NULL,error_scope=NULL,failure_count=0,poll_version=poll_version+1 WHERE source_id=?',
      ).run(i.nextPollAt, new Date().toISOString(), g.id)
      return {
        inserted,
        duplicates: events.length - inserted,
        connection: get(g.id),
      }
    }),
    recordFailure: db.transaction((i: GithubFailureInput) => {
      if (
        i.errorScope !== undefined &&
        !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(i.errorScope)
      )
        invalid()
      integer(i.nextPollAt)
      if (!githubFailureCodes.includes(i.errorCode)) invalid()
      let g: GithubAuthorized
      try {
        g = check(i)
      } catch (error) {
        if (
          error instanceof Error &&
          [
            'GITHUB_GRANT_CHANGED',
            'GITHUB_DISABLED',
            'GITHUB_CURSOR_CHANGED',
            'GITHUB_POLL_CHANGED',
          ].includes(error.message)
        )
          return false
        throw error
      }
      db.prepare(
        'UPDATE github_connections SET next_poll_at=?,error_code=?,error_scope=?,failure_count=min(failure_count+1,1000000),poll_version=poll_version+1 WHERE source_id=?',
      ).run(
        Math.max(g.nextPollAt, i.nextPollAt),
        i.errorCode,
        i.errorScope ?? null,
        g.id,
      )
      return true
    }),
    records(i: { id: string; cursor?: string; limit?: number }) {
      const g = getAuthorized(i.id),
        limit = i.limit ?? 20
      integer(limit, 1)
      if (limit > 50) invalid()
      const before =
        i.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(i.cursor)
      if (i.cursor !== undefined && !/^[1-9][0-9]{0,15}$/.test(i.cursor))
        invalid()
      integer(before, 1)
      const records: {
        id: number
        externalId: string
        revision: string
        occurredAt: string
        receivedAt: string
        text: string
        role: 'tool'
      }[] = []
      let bytes = 128,
        more = false
      for (const row of db
        .prepare(
          `SELECT e.id,e.external_id AS externalId,e.revision,e.occurred_at AS occurredAt,e.received_at AS receivedAt,e.content AS text,e.role,e.operation FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE e.source_id=? AND ep.project_id=? AND e.id<? ORDER BY e.id DESC LIMIT ?`,
        )
        .iterate(g.id, g.projectId, before, limit + 1) as Iterable<
        (typeof records)[number] & { operation: 'upsert' | 'retract' }
      >) {
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
        if (records.length === limit || bytes + size > 512 * 1024) {
          more = true
          break
        }
        // Persisted records are observations bound to this exact connection.
        validateEvent(
          {
            schemaVersion: 1,
            sourceInstanceId: g.id,
            externalId: row.externalId,
            revision: row.revision,
            occurredAt: row.occurredAt,
            role: row.role,
            operation: row.operation,
            text: row.text,
          },
          g,
        )
        const { operation, ...record } = row
        records.push(record)
        bytes += size
      }
      if (more && !records.length) throw Error('GITHUB_INVALID_RESPONSE')
      return { records, nextCursor: more ? String(records.at(-1)!.id) : null }
    },
  }
}

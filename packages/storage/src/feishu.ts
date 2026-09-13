import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
import { parseContextTimestamp } from '@memo/domain'
export const feishuFailureCodes = [
  'FEISHU_AUTH_FAILED',
  'FEISHU_PERMISSION_DENIED',
  'FEISHU_RATE_LIMITED',
  'FEISHU_API_FAILED',
  'FEISHU_HTTP_FAILED',
  'FEISHU_INVALID_RESPONSE',
  'FEISHU_CREDENTIAL_UNAVAILABLE',
  'FEISHU_PAGE_LOOP',
  'FEISHU_PAGE_LIMIT',
  'INGESTION_QUEUE_LIMIT',
  'INGESTION_DATABASE_LIMIT',
  'INGESTION_DISK_LOW',
  'INGESTION_PROBE_UNAVAILABLE',
] as const
export type FeishuFailureCode = (typeof feishuFailureCodes)[number]
export interface FeishuConnection {
  windowActive: boolean
  windowStart: number
  windowEnd: number
  id: string
  projectId: string
  chatId: string
  credentialId: string
  grantVersion: number
  status: 'active' | 'paused' | 'revoked' | 'error'
  startTime: number
  completedThrough: number | null
  nextPollAt: number
  lastSuccessAt: string | null
  errorCode: FeishuFailureCode | null
  failureCount: number
  eventCount: number
}
export interface FeishuAuthorized extends FeishuConnection {
  enabled: boolean
  revoked: boolean
  pollVersion: number
  pageToken: string
  windowStart: number
  windowEnd: number
  windowActive: boolean
}
export interface FeishuAuthorizeInput {
  projectId: string
  chatId: string
  credentialId: string
  startTime: number
  endTime: number
}
export interface FeishuFence {
  id: string
  expectedGrantVersion: number
  expectedPollVersion: number
}
export interface FeishuBatchInput extends FeishuFence {
  expectedPageToken: string
  expectedWindowStart: number
  expectedWindowEnd: number
  events: SourceEvent[]
  nextPageToken: string
  nextPollAt: number
}
export interface FeishuFailureInput extends FeishuFence {
  errorCode: FeishuFailureCode
  nextPollAt: number
}
const DAY = 86400000,
  MAX_TIME = 8640000000000000
function invalid(): never {
  throw Error('FEISHU_INVALID_INPUT')
}
function int(
  v: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    invalid()
}
function time(v: unknown, aligned = false): asserts v is number {
  int(v, 0, aligned ? 253402300799000 : MAX_TIME)
  if (aligned && v % 1000) invalid()
}
function uuid(v: unknown): asserts v is string {
  if (
    typeof v !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v,
    )
  )
    invalid()
}
function project(v: unknown): asserts v is string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(v)
  )
    invalid()
}
function token(v: unknown): asserts v is string {
  if (
    typeof v !== 'string' ||
    v.length > 4096 ||
    /[\s\u0000-\u001f\u007f]/u.test(v)
  )
    invalid()
}
const summary = `SELECT f.source_id AS id,f.project_id AS projectId,f.chat_id AS chatId,f.credential_id AS credentialId,f.grant_version AS grantVersion,f.start_time AS startTime,f.window_start AS windowStart,f.window_end AS windowEnd,f.window_active AS windowActive,f.completed_through AS completedThrough,f.next_poll_at AS nextPollAt,f.last_success_at AS lastSuccessAt,f.error_code AS errorCode,f.failure_count AS failureCount,CASE WHEN f.revoked=1 THEN 'revoked' WHEN f.enabled=0 THEN 'paused' WHEN f.error_code IS NOT NULL THEN 'error' ELSE 'active' END AS status,(SELECT count(*) FROM source_events e JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=f.project_id WHERE e.source_id=f.source_id) AS eventCount FROM feishu_connections f`
export function migrateFeishu(db: Database.Database) {
  db.transaction(() =>
    db.exec(`CREATE TABLE feishu_connections(source_id TEXT PRIMARY KEY REFERENCES source_instances(id),project_id TEXT NOT NULL REFERENCES projects(id),chat_id TEXT NOT NULL,credential_id TEXT NOT NULL,grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version>0 AND grant_version<=9007199254740991),poll_version INTEGER NOT NULL DEFAULT 1 CHECK(poll_version>0 AND poll_version<=9007199254740991),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)),revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1)),start_time INTEGER NOT NULL CHECK(start_time>=0 AND start_time<=253402300799000 AND start_time%1000=0),completed_through INTEGER CHECK(completed_through IS NULL OR (completed_through>=start_time AND completed_through<=253402300799000 AND completed_through%1000=0)),window_start INTEGER NOT NULL CHECK(window_start>=start_time AND window_start%1000=0),window_end INTEGER NOT NULL CHECK(window_end>window_start AND window_end<=253402300799000 AND window_end%1000=0),window_active INTEGER NOT NULL DEFAULT 1 CHECK(window_active IN(0,1)),page_token TEXT NOT NULL DEFAULT '' CHECK(length(page_token)<=4096),page_count INTEGER NOT NULL DEFAULT 0 CHECK(page_count>=0 AND page_count<=10000),reset_attempts INTEGER NOT NULL DEFAULT 0 CHECK(reset_attempts>=0 AND reset_attempts<=1000000),next_poll_at INTEGER NOT NULL DEFAULT 0 CHECK(next_poll_at>=0 AND next_poll_at<=8640000000000000),last_success_at TEXT,error_code TEXT CHECK(error_code IS NULL OR error_code IN(${feishuFailureCodes.map((c) => `'${c}'`).join(',')})),failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count>=0));
 CREATE UNIQUE INDEX feishu_active_chat ON feishu_connections(project_id,chat_id) WHERE revoked=0;
 CREATE TABLE feishu_page_tokens(source_id TEXT NOT NULL REFERENCES feishu_connections(source_id),page_token TEXT NOT NULL,PRIMARY KEY(source_id,page_token));
 CREATE TABLE feishu_credential_cooldowns(credential_id TEXT PRIMARY KEY,not_before INTEGER NOT NULL CHECK(not_before>=0 AND not_before<=8640000000000000),failure_count INTEGER NOT NULL CHECK(failure_count>=1 AND failure_count<=1000000));PRAGMA user_version=13;`),
  )()
}
export function createFeishu(
  db: Database.Database,
  receive: (event: SourceEvent, cursor: string) => { inserted: boolean },
  observe: (projectId: string, eventId: number) => void,
  now: () => number = Date.now,
) {
  function get(id: string): FeishuConnection {
    uuid(id)
    const value = db.prepare(`${summary} WHERE f.source_id=?`).get(id) as
      | FeishuConnection
      | undefined
    if (!value) throw Error('FEISHU_NOT_FOUND')
    return { ...value, windowActive: !!value.windowActive }
  }
  function getAuthorized(id: string): FeishuAuthorized {
    const value = get(id)
    const row = db
      .prepare(
        'SELECT enabled,revoked,poll_version AS pollVersion,page_token AS pageToken,window_start AS windowStart,window_end AS windowEnd,window_active AS windowActive FROM feishu_connections WHERE source_id=?',
      )
      .get(id) as {
      enabled: number
      revoked: number
      pollVersion: number
      pageToken: string
      windowStart: number
      windowEnd: number
      windowActive: number
    }
    token(row.pageToken)
    if (
      row.windowActive &&
      !db
        .prepare(
          'SELECT 1 FROM feishu_page_tokens WHERE source_id=? AND page_token=?',
        )
        .get(id, row.pageToken)
    )
      throw Error('FEISHU_INVALID_RESPONSE')
    return {
      ...value,
      ...row,
      enabled: !!row.enabled,
      revoked: !!row.revoked,
      windowActive: !!row.windowActive,
    }
  }
  function fence(i: FeishuFence) {
    int(i.expectedGrantVersion, 1)
    int(i.expectedPollVersion, 1)
    const g = getAuthorized(i.id)
    if (g.grantVersion !== i.expectedGrantVersion)
      throw Error('FEISHU_GRANT_CHANGED')
    if (g.pollVersion !== i.expectedPollVersion)
      throw Error('FEISHU_POLL_CHANGED')
    if (!g.enabled || g.revoked) throw Error('FEISHU_DISABLED')
    return g
  }
  function getCooldown(credentialId: string) {
    uuid(credentialId)
    return (
      (db
        .prepare(
          'SELECT not_before AS notBefore,failure_count AS failureCount FROM feishu_credential_cooldowns WHERE credential_id=?',
        )
        .get(credentialId) as
        | { notBefore: number; failureCount: number }
        | undefined) ?? { notBefore: 0, failureCount: 0 }
    )
  }
  function storeCursor(g: FeishuAuthorized, pageToken: string) {
    db.prepare('UPDATE source_instances SET cursor=? WHERE id=?').run(
      JSON.stringify({
        windowStart: g.windowStart,
        windowEnd: g.windowEnd,
        pageToken,
      }),
      g.id,
    )
  }
  return {
    getAuthorized,
    getCooldown,
    list(): FeishuConnection[] {
      return (
        db
          .prepare(`${summary} ORDER BY f.source_id`)
          .all() as FeishuConnection[]
      ).map((row) => ({ ...row, windowActive: !!row.windowActive }))
    },
    recordCooldown: db.transaction(
      (i: { credentialId: string; notBefore: number }) => {
        uuid(i.credentialId)
        time(i.notBefore)
        db.prepare(
          'INSERT INTO feishu_credential_cooldowns VALUES(?,?,1) ON CONFLICT(credential_id) DO UPDATE SET not_before=MAX(not_before,excluded.not_before),failure_count=MIN(failure_count+1,1000000)',
        ).run(i.credentialId, i.notBefore)
        return getCooldown(i.credentialId)
      },
    ),
    authorize: db.transaction((i: FeishuAuthorizeInput) => {
      project(i.projectId)
      uuid(i.credentialId)
      time(i.startTime, true)
      time(i.endTime, true)
      if (
        i.startTime >= i.endTime ||
        typeof i.chatId !== 'string' ||
        !/^oc_[A-Za-z0-9_-]{1,252}$/.test(i.chatId)
      )
        invalid()
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(i.projectId))
        invalid()
      if (
        db
          .prepare(
            'SELECT 1 FROM feishu_connections WHERE project_id=? AND chat_id=? AND revoked=0',
          )
          .get(i.projectId, i.chatId)
      )
        throw Error('FEISHU_DUPLICATE')
      const id = randomUUID()
      db.prepare('INSERT INTO source_instances(id) VALUES(?)').run(id)
      db.prepare(
        'INSERT INTO feishu_connections(source_id,project_id,chat_id,credential_id,start_time,window_start,window_end) VALUES(?,?,?,?,?,?,?)',
      ).run(
        id,
        i.projectId,
        i.chatId,
        i.credentialId,
        i.startTime,
        i.startTime,
        Math.min(i.startTime + DAY, i.endTime),
      )
      db.prepare("INSERT INTO feishu_page_tokens VALUES(?,'')").run(id)
      storeCursor(getAuthorized(id), '')
      return get(id)
    }),
    setEnabled: db.transaction((id: string, enabled: boolean) => {
      if (typeof enabled !== 'boolean') invalid()
      const g = getAuthorized(id)
      if (g.revoked) throw Error('FEISHU_DISABLED')
      if (g.enabled !== enabled)
        db.prepare(
          'UPDATE feishu_connections SET enabled=?,grant_version=grant_version+1,poll_version=poll_version+1 WHERE source_id=?',
        ).run(enabled ? 1 : 0, id)
      return get(id)
    }),
    revoke: db.transaction((id: string) => {
      const g = getAuthorized(id)
      if (!g.revoked)
        db.prepare(
          'UPDATE feishu_connections SET revoked=1,enabled=0,grant_version=grant_version+1,poll_version=poll_version+1 WHERE source_id=?',
        ).run(id)
      return get(id)
    }),
    beginWindow: db.transaction((i: FeishuFence & { until: number }) => {
      time(i.until, true)
      const g = fence(i)
      if (g.windowActive || g.completedThrough === null)
        throw Error('FEISHU_WINDOW_CHANGED')
      if (i.until <= g.completedThrough) throw Error('FEISHU_NOT_DUE')
      const start = Math.max(g.startTime, g.completedThrough - 120000),
        end = Math.min(g.completedThrough + DAY, i.until)
      db.prepare(
        "UPDATE feishu_connections SET window_start=?,window_end=?,window_active=1,page_token='',page_count=0,reset_attempts=0,poll_version=poll_version+1 WHERE source_id=?",
      ).run(start, end, g.id)
      db.prepare('DELETE FROM feishu_page_tokens WHERE source_id=?').run(g.id)
      db.prepare("INSERT INTO feishu_page_tokens VALUES(?,'')").run(g.id)
      const updated = getAuthorized(g.id)
      storeCursor(updated, '')
      return updated
    }),
    restartWindow: db.transaction((i: FeishuFence) => {
      const g = fence(i)
      if (!g.windowActive) throw Error('FEISHU_WINDOW_CHANGED')
      const row = db
        .prepare(
          'SELECT reset_attempts AS n FROM feishu_connections WHERE source_id=?',
        )
        .get(g.id) as { n: number }
      const current = now()
      time(current)
      const next = Math.min(
        MAX_TIME,
        Math.max(
          g.nextPollAt,
          current + Math.min(3600000, 30000 * 2 ** Math.min(row.n, 7)),
        ),
      )
      db.prepare(
        "UPDATE feishu_connections SET page_token='',page_count=0,reset_attempts=MIN(reset_attempts+1,1000000),poll_version=poll_version+1,next_poll_at=?,error_code=NULL WHERE source_id=?",
      ).run(next, g.id)
      db.prepare('DELETE FROM feishu_page_tokens WHERE source_id=?').run(g.id)
      db.prepare("INSERT INTO feishu_page_tokens VALUES(?,'')").run(g.id)
      storeCursor(g, '')
      return getAuthorized(g.id)
    }),
    receiveBatch: db.transaction((i: FeishuBatchInput) => {
      token(i.expectedPageToken)
      token(i.nextPageToken)
      time(i.expectedWindowStart, true)
      time(i.expectedWindowEnd, true)
      time(i.nextPollAt)
      const g = fence(i)
      if (
        !g.windowActive ||
        g.windowStart !== i.expectedWindowStart ||
        g.windowEnd !== i.expectedWindowEnd ||
        g.pageToken !== i.expectedPageToken
      )
        throw Error('FEISHU_WINDOW_CHANGED')
      const count = (
        db
          .prepare(
            'SELECT page_count AS n FROM feishu_connections WHERE source_id=?',
          )
          .get(g.id) as { n: number }
      ).n
      if (count >= 10000) throw Error('FEISHU_PAGE_LIMIT')
      if (
        i.nextPageToken &&
        db
          .prepare(
            'SELECT 1 FROM feishu_page_tokens WHERE source_id=? AND page_token=?',
          )
          .get(g.id, i.nextPageToken)
      )
        throw Error('FEISHU_PAGE_LOOP')
      if (!Array.isArray(i.events) || i.events.length > 50) invalid()
      const events = i.events.map((input) => {
        const e = structuredClone(parseSourceEvent(input))
        if (e.sourceInstanceId !== g.id) invalid()
        const t = parseContextTimestamp(e.occurredAt)
        const milliseconds = t.epochSeconds * 1000 + t.nanosecond / 1e6
        if (milliseconds < g.windowStart || milliseconds > g.windowEnd)
          throw Error('FEISHU_INVALID_RESPONSE')
        return e
      })
      if (events.reduce((n, e) => n + e.text.length, 0) > 4 * 1024 * 1024)
        invalid()
      let inserted = 0
      for (const e of events) {
        if (
          receive(
            e,
            JSON.stringify({
              windowStart: g.windowStart,
              windowEnd: g.windowEnd,
              pageToken: i.nextPageToken,
            }),
          ).inserted
        )
          inserted++
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
      if (i.nextPageToken)
        db.prepare('INSERT INTO feishu_page_tokens VALUES(?,?)').run(
          g.id,
          i.nextPageToken,
        )
      db.prepare(
        'UPDATE feishu_connections SET page_token=?,page_count=page_count+1,window_active=?,completed_through=CASE WHEN ?=0 THEN window_end ELSE completed_through END,next_poll_at=?,last_success_at=?,error_code=NULL,failure_count=0,poll_version=poll_version+1 WHERE source_id=?',
      ).run(
        i.nextPageToken,
        i.nextPageToken ? 1 : 0,
        i.nextPageToken ? 1 : 0,
        i.nextPollAt,
        new Date(now()).toISOString(),
        g.id,
      )
      storeCursor(g, i.nextPageToken)
      return {
        inserted,
        duplicates: events.length - inserted,
        connection: get(g.id),
      }
    }),
    recordFailure: db.transaction((i: FeishuFailureInput) => {
      time(i.nextPollAt)
      if (!feishuFailureCodes.includes(i.errorCode)) invalid()
      let g: FeishuAuthorized
      try {
        g = fence(i)
      } catch (e) {
        if (
          e instanceof Error &&
          [
            'FEISHU_GRANT_CHANGED',
            'FEISHU_POLL_CHANGED',
            'FEISHU_DISABLED',
          ].includes(e.message)
        )
          return false
        throw e
      }
      db.prepare(
        'UPDATE feishu_connections SET next_poll_at=MAX(next_poll_at,?),failure_count=MIN(failure_count+1,1000000),error_code=?,poll_version=poll_version+1 WHERE source_id=?',
      ).run(i.nextPollAt, i.errorCode, g.id)
      return true
    }),
    records(i: { id: string; cursor?: string; limit?: number }) {
      const g = getAuthorized(i.id),
        limit = i.limit ?? 20
      int(limit, 1, 50)
      const before =
        i.cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(i.cursor)
      if (i.cursor !== undefined && !/^[1-9][0-9]{0,15}$/.test(i.cursor))
        invalid()
      int(before, 1)
      const records: {
        id: number
        externalId: string
        revision: string
        occurredAt: string
        receivedAt: string
        text: string
        role: SourceEvent['role']
        operation: 'upsert' | 'retract'
      }[] = []
      let bytes = 128,
        more = false
      for (const row of db
        .prepare(
          `SELECT e.id,e.external_id AS externalId,e.revision,e.occurred_at AS occurredAt,e.received_at AS receivedAt,e.content AS text,e.role,e.operation FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE e.source_id=? AND ep.project_id=? AND e.id<? ORDER BY e.id DESC LIMIT ?`,
        )
        .iterate(g.id, g.projectId, before, limit + 1) as Iterable<
        (typeof records)[number]
      >) {
        const size = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
        if (records.length === limit || bytes + size > 512 * 1024) {
          more = true
          break
        }
        parseSourceEvent({
          schemaVersion: 1,
          sourceInstanceId: g.id,
          externalId: row.externalId,
          revision: row.revision,
          occurredAt: row.occurredAt,
          role: row.role,
          text: row.text,
          operation: row.operation,
        })
        records.push(row)
        bytes += size
      }
      if (more && !records.length) throw Error('FEISHU_INVALID_RESPONSE')
      return { records, nextCursor: more ? String(records.at(-1)!.id) : null }
    },
  }
}

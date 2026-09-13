import { storedMetadataMatches } from './event-metadata'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, normalize } from 'node:path'
import { validateSourceEvent, type SourceEvent } from '@memo/contracts'

export const sourceImportErrorCodes = [
  'IMPORT_FAILED',
  'SOURCE_REVISION_CONFLICT',
  'FILE_UNAVAILABLE',
  'UNSAFE_PATH',
  'FILE_TOO_LARGE',
  'LINE_TOO_LARGE',
  'FILE_CHANGED',
  'INVALID_UTF8',
  'INVALID_JSONL',
  'INVALID_SOURCE_EVENT',
  'INVALID_CURSOR',
  'INVALID_MANIFEST',
  'IMPORT_INVALID_DATA',
  'IMPORT_LIMIT_EXCEEDED',
] as const
export type SourceImportErrorCode = (typeof sourceImportErrorCodes)[number]
export interface SourceSummary {
  id: string
  projectId: string
  displayName: string
  status: 'active' | 'revoked' | 'error'
  grantVersion: number
  lastSuccessAt: string | null
  eventCount: number
  errorCode: SourceImportErrorCode | null
}
export interface AuthorizedSource extends SourceSummary {
  path: string
  cursor: string
}
function id(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    value.includes('\0')
  )
    throw new Error('INVALID_SOURCE_INPUT')
}
function version(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('INVALID_SOURCE_VERSION')
}
function cursorText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 16384 || value.includes('\0'))
    throw new Error('INVALID_SOURCE_CURSOR')
}
const summarySQL = `SELECT g.source_id AS id,g.project_id AS projectId,g.display_name AS displayName,
  CASE WHEN g.revoked=1 THEN 'revoked' WHEN g.error_code IS NOT NULL THEN 'error' ELSE 'active' END AS status,
  g.grant_version AS grantVersion,g.last_success_at AS lastSuccessAt,g.error_code AS errorCode,
  (SELECT count(*) FROM source_events e WHERE e.source_id=g.source_id) AS eventCount
  FROM source_grants g JOIN source_instances s ON s.id=g.source_id`
export function migrateSources(db: Database.Database) {
  db.transaction(() =>
    db.exec(`CREATE TABLE source_grants(
    source_id TEXT PRIMARY KEY REFERENCES source_instances(id),project_id TEXT NOT NULL REFERENCES projects(id),
    path TEXT NOT NULL,display_name TEXT NOT NULL,grant_version INTEGER NOT NULL DEFAULT 1 CHECK(grant_version>=1 AND grant_version<=9007199254740991),
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),last_success_at TEXT,
    error_code TEXT CHECK(error_code IS NULL OR error_code IN ('IMPORT_FAILED','SOURCE_REVISION_CONFLICT','FILE_UNAVAILABLE','UNSAFE_PATH','FILE_TOO_LARGE','LINE_TOO_LARGE','FILE_CHANGED','INVALID_UTF8','INVALID_JSONL','INVALID_SOURCE_EVENT','INVALID_CURSOR','INVALID_MANIFEST','IMPORT_INVALID_DATA','IMPORT_LIMIT_EXCEEDED')),
    UNIQUE(path,project_id));PRAGMA user_version=5;`),
  )()
}
export function createSources(
  db: Database.Database,
  receive: (event: SourceEvent, cursor: string) => { inserted: boolean },
  onEventReceived?: (projectId: string, eventId: number) => void,
) {
  function get(sourceId: string): SourceSummary {
    id(sourceId)
    const source = db
      .prepare(`${summarySQL} WHERE g.source_id=?`)
      .get(sourceId) as SourceSummary | undefined
    if (!source) throw new Error('UNKNOWN_SOURCE_GRANT')
    return source
  }
  function authorized(sourceId: string, expected?: number): AuthorizedSource {
    const source = get(sourceId)
    if (source.status === 'revoked') throw new Error('SOURCE_REVOKED')
    if (expected !== undefined) {
      version(expected)
      if (expected !== source.grantVersion)
        throw new Error('SOURCE_GRANT_CHANGED')
    }
    const stored = db
      .prepare(
        'SELECT g.path,s.cursor FROM source_grants g JOIN source_instances s ON s.id=g.source_id WHERE g.source_id=?',
      )
      .get(sourceId) as { path: string; cursor: string }
    return { ...source, ...stored }
  }
  return {
    authorize: db.transaction(
      (input: { path: string; projectId: string }): SourceSummary => {
        id(input.projectId)
        if (
          typeof input.path !== 'string' ||
          !isAbsolute(input.path) ||
          input.path.length > 4096 ||
          input.path.includes('\0')
        )
          throw new Error('INVALID_SOURCE_PATH')
        if (
          !db.prepare('SELECT 1 FROM projects WHERE id=?').get(input.projectId)
        )
          throw new Error('UNKNOWN_PROJECT')
        // The host supplies a canonical realpath from its native picker. Storage never touches source files.
        const path = input.path
        if (normalize(path) !== path) throw new Error('INVALID_SOURCE_PATH')
        const existing = db
          .prepare(
            'SELECT source_id AS id FROM source_grants WHERE path=? AND project_id=?',
          )
          .get(path, input.projectId) as { id: string } | undefined
        if (existing) {
          db.prepare(
            'UPDATE source_grants SET grant_version=grant_version+1,revoked=0,error_code=NULL WHERE source_id=?',
          ).run(existing.id)
          return get(existing.id)
        }
        const sourceId = randomUUID()
        db.prepare('INSERT INTO source_instances(id) VALUES(?)').run(sourceId)
        // Filename only: full path stays private to the host/core API.
        const displayName =
          basename(path)
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .slice(0, 256) || '本地记录'
        db.prepare(
          'INSERT INTO source_grants(source_id,project_id,path,display_name) VALUES(?,?,?,?)',
        ).run(sourceId, input.projectId, path, displayName)
        return get(sourceId)
      },
    ),
    list(): SourceSummary[] {
      return db
        .prepare(`${summarySQL} ORDER BY g.source_id`)
        .all() as SourceSummary[]
    },
    getAuthorized(sourceId: string): AuthorizedSource {
      return authorized(sourceId)
    },
    receiveBatch: db.transaction(
      (
        sourceId: string,
        expectedGrantVersion: number,
        events: SourceEvent[],
        cursor: string,
        expectedCursor?: string,
      ) => {
        const source = authorized(sourceId, expectedGrantVersion)
        cursorText(cursor)
        if (expectedCursor !== undefined) {
          cursorText(expectedCursor)
          if (expectedCursor !== source.cursor)
            throw new Error('SOURCE_CURSOR_CHANGED')
        }
        if (!Array.isArray(events) || events.length > 500)
          throw new Error('IMPORT_LIMIT_EXCEEDED')
        let total = 0
        for (const event of events) {
          if (
            !validateSourceEvent(event) ||
            event.sourceInstanceId !== sourceId
          )
            throw new Error('IMPORT_INVALID_DATA')
          total += event.text.length
          if (total > 4 * 1024 * 1024) throw new Error('IMPORT_LIMIT_EXCEEDED')
        }
        let inserted = 0
        for (const event of events) {
          const prior = db
            .prepare(
              'SELECT content,role,occurred_at,operation,metadata_json FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
            )
            .get(sourceId, event.externalId, event.revision) as
            | {
                content: string
                role: string
                occurred_at: string
                operation: string
                metadata_json: string | null
              }
            | undefined
          if (
            prior &&
            (!storedMetadataMatches(prior.metadata_json, event.metadata) ||
              prior.operation !== (event.operation ?? 'upsert') ||
              prior.content !== event.text ||
              prior.role !== event.role ||
              prior.occurred_at !== event.occurredAt)
          )
            throw new Error('SOURCE_REVISION_CONFLICT')
          if (receive(event, cursor).inserted) inserted++
          const stored = db
            .prepare(
              'SELECT id FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
            )
            .get(sourceId, event.externalId, event.revision) as { id: number }
          db.prepare(
            'INSERT INTO event_projects(project_id,event_id) VALUES(?,?) ON CONFLICT DO NOTHING',
          ).run(source.projectId, stored.id)
          onEventReceived?.(source.projectId, stored.id)
        }
        // An empty valid page still advances the checkpoint in the same transaction.
        db.prepare('UPDATE source_instances SET cursor=? WHERE id=?').run(
          cursor,
          sourceId,
        )
        db.prepare(
          'UPDATE source_grants SET last_success_at=?,error_code=NULL WHERE source_id=?',
        ).run(new Date().toISOString(), sourceId)
        return {
          inserted,
          duplicates: events.length - inserted,
          source: get(sourceId),
        }
      },
    ),
    revoke: db.transaction((sourceId: string): SourceSummary => {
      get(sourceId)
      db.prepare(
        'UPDATE source_grants SET revoked=1,grant_version=grant_version+1 WHERE source_id=?',
      ).run(sourceId)
      return get(sourceId)
    }),
    recordError: db.transaction(
      (
        sourceId: string,
        expectedGrantVersion: number,
        errorCode: SourceImportErrorCode,
      ): boolean => {
        id(sourceId)
        version(expectedGrantVersion)
        if (!sourceImportErrorCodes.includes(errorCode))
          throw new Error('INVALID_SOURCE_ERROR')
        return (
          db
            .prepare(
              'UPDATE source_grants SET error_code=? WHERE source_id=? AND grant_version=? AND revoked=0',
            )
            .run(errorCode, sourceId, expectedGrantVersion).changes === 1
        )
      },
    ),
  }
}

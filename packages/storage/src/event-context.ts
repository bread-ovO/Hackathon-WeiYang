import type Database from 'better-sqlite3'
import type { SourceEvent } from '@memo/contracts'
import {
  normalizeEventTime,
  normalizeIdentity,
  type NormalizedEventTime,
  type NormalizedIdentity,
} from '@memo/domain'

export interface StoredEventContext {
  eventId: number
  identity: NormalizedIdentity | null
  identityStatus: 'available' | 'invalid_source_identity'
  revision: string
  time: NormalizedEventTime | null
  status: 'normalized' | 'invalid_legacy_time'
}

/** Host reception time and the source's explicit offset are separate facts. */
export function eventTimeContext(
  event: Pick<SourceEvent, 'occurredAt'>,
  receivedAt: string,
): NormalizedEventTime {
  return normalizeEventTime({ occurredAt: event.occurredAt, receivedAt })
}

export function migrateEventContexts(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE event_contexts (
      event_id INTEGER PRIMARY KEY REFERENCES source_events(id),
      time_json TEXT,
      status TEXT NOT NULL CHECK(status IN ('normalized','invalid_legacy_time')),
      CHECK((status='normalized' AND time_json IS NOT NULL) OR
            (status='invalid_legacy_time' AND time_json IS NULL))
    );`)
    const insert = db.prepare(
      'INSERT INTO event_contexts(event_id,time_json,status) VALUES(?,?,?)',
    )
    // Old rows are preserved as evidence even if their dates predate strict validation.
    // They must not gain an invented timezone or silently participate in plan ordering.
    const page = db.prepare(
      'SELECT id,occurred_at,received_at FROM source_events WHERE id>? ORDER BY id LIMIT 500',
    )
    let after = 0
    while (true) {
      const rows = page.all(after) as {
        id: number
        occurred_at: string
        received_at: string
      }[]
      if (!rows.length) break
      for (const row of rows) {
        let time: NormalizedEventTime | null = null
        try {
          time = eventTimeContext(
            { occurredAt: row.occurred_at },
            row.received_at,
          )
        } catch {
          /* explicitly unavailable */
        }
        insert.run(
          row.id,
          time ? JSON.stringify(time) : null,
          time ? 'normalized' : 'invalid_legacy_time',
        )
      }
      after = rows[rows.length - 1]!.id
    }
    db.pragma('user_version = 7')
  })()
}

export function createEventContexts(db: Database.Database) {
  return {
    record(event: SourceEvent, eventId: number, receivedAt: string) {
      let time: NormalizedEventTime
      try {
        time = eventTimeContext(event, receivedAt)
      } catch {
        throw new Error('INVALID_SOURCE_EVENT')
      }
      db.prepare(
        "INSERT INTO event_contexts(event_id,time_json,status) VALUES(?,?,'normalized')",
      ).run(eventId, JSON.stringify(time))
    },
    /** Internal consumer API: project membership is checked, never inferred from a name. */
    get(projectId: string, eventId: number): StoredEventContext | null {
      if (
        typeof projectId !== 'string' ||
        !projectId.length ||
        projectId.length > 256 ||
        !Number.isSafeInteger(eventId) ||
        eventId < 1
      )
        throw new Error('INVALID_EVENT_CONTEXT')
      const row = db
        .prepare(
          `SELECT e.source_id,e.external_id,e.revision,c.time_json,c.status
        FROM event_projects p JOIN source_events e ON e.id=p.event_id
        JOIN event_contexts c ON c.event_id=e.id WHERE p.project_id=? AND e.id=?`,
        )
        .get(projectId, eventId) as
        | {
            source_id: string
            external_id: string
            revision: string
            time_json: string | null
            status: StoredEventContext['status']
          }
        | undefined
      if (!row) return null
      // This identifies a source object, not its author. role/display names are not person IDs.
      let identity: NormalizedIdentity | null = null
      try {
        identity = normalizeIdentity({
          sourceInstanceId: row.source_id,
          namespace: 'source-event',
          subjectId: row.external_id,
          projectId,
        })
      } catch {
        // The v1 event contract accepts opaque IDs that the context contract cannot
        // represent. Preserve them unchanged; never trim/rename or infer an identity.
      }
      let time: NormalizedEventTime | null = null
      if (row.time_json !== null) {
        try {
          const stored = JSON.parse(row.time_json) as NormalizedEventTime
          time = normalizeEventTime({
            occurredAt: stored.occurred.original,
            receivedAt: stored.received.original,
          })
        } catch {
          throw new Error('INVALID_EVENT_CONTEXT')
        }
      }
      return {
        eventId,
        identity,
        identityStatus: identity ? 'available' : 'invalid_source_identity',
        revision: row.revision,
        time,
        status: row.status,
      }
    },
  }
}

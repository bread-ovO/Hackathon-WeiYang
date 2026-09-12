import type Database from 'better-sqlite3'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'

/** All ingress paths share the same revision identity and atomic event/job/cursor
 * boundary. A revision is immutable; edits must have a new revision identifier. */
export function createEventReceiver(
  db: Database.Database,
  onInserted?: (event: SourceEvent, id: number, receivedAt: string) => void,
): (event: SourceEvent, cursor: string) => { inserted: boolean } {
  const receive = db.transaction((event: SourceEvent, cursor: string) => {
    if (
      !db
        .prepare('SELECT id FROM source_instances WHERE id=?')
        .get(event.sourceInstanceId)
    )
      throw new Error('UNKNOWN_SOURCE')
    const prior = db
      .prepare(
        'SELECT content,role,occurred_at FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
      )
      .get(event.sourceInstanceId, event.externalId, event.revision) as
      | { content: string; role: string; occurred_at: string }
      | undefined
    if (
      prior &&
      (prior.content !== event.text ||
        prior.role !== event.role ||
        prior.occurred_at !== event.occurredAt)
    )
      throw new Error('SOURCE_REVISION_CONFLICT')
    if (prior) {
      db.prepare('UPDATE source_instances SET cursor=? WHERE id=?').run(
        cursor,
        event.sourceInstanceId,
      )
      return { inserted: false }
    }
    const receivedAt = new Date().toISOString()
    const result = db
      .prepare(
        `INSERT INTO source_events
      (source_id,external_id,revision,occurred_at,received_at,role,content) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        event.sourceInstanceId,
        event.externalId,
        event.revision,
        event.occurredAt,
        receivedAt,
        event.role,
        event.text,
      )
    const id = Number(result.lastInsertRowid)
    if (!Number.isSafeInteger(id)) throw new Error('INVALID_EVENT_ID')
    // Context registration participates in the exact same transaction. It is
    // invoked only once, using the same received_at stored on the source event.
    onInserted?.(event, id, receivedAt)
    db.prepare('INSERT INTO jobs(event_id) VALUES (?)').run(id)
    db.prepare('UPDATE source_instances SET cursor=? WHERE id=?').run(
      cursor,
      event.sourceInstanceId,
    )
    return { inserted: true }
  })
  return (input, cursor) => {
    const event = structuredClone(parseSourceEvent(input))
    // Shared ingress must admit the plugin host's bounded HTTP seen-set cursor.
    // Narrower adapters (e.g. application receiveEvent) keep their own limits.
    if (typeof cursor !== 'string' || cursor.length > 16384)
      throw new Error('CURSOR_TOO_LARGE')
    return receive.immediate(event, cursor)
  }
}

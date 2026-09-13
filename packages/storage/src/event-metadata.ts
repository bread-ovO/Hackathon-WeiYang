import type Database from 'better-sqlite3'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'

/** Metadata describes a source claim, never a verified local-user identity. */
export function serializeEventMetadata(
  metadata: SourceEvent['metadata'],
): string | null {
  if (metadata === undefined) return null
  let validated: NonNullable<SourceEvent['metadata']>
  try {
    validated = parseSourceEvent({
      schemaVersion: 1,
      sourceInstanceId: 'metadata-validation',
      externalId: 'metadata-validation',
      revision: '1',
      occurredAt: '2026-01-01T00:00:00Z',
      role: 'system',
      text: '',
      metadata,
    }).metadata!
  } catch {
    throw Error('INVALID_EVENT_METADATA')
  }
  return JSON.stringify({
    ...(validated.author
      ? {
          author: {
            namespace: validated.author.namespace,
            subjectId: validated.author.subjectId,
          },
        }
      : {}),
    ...(validated.replyToExternalId
      ? { replyToExternalId: validated.replyToExternalId }
      : {}),
  })
}
export function eventMetadataFields(
  raw: unknown,
): Pick<SourceEvent, 'metadata'> {
  if (raw === null) return {}
  if (typeof raw !== 'string' || raw.length > 8192)
    throw Error('INVALID_EVENT_METADATA')
  let value: SourceEvent['metadata']
  try {
    value = JSON.parse(raw) as SourceEvent['metadata']
  } catch {
    throw Error('INVALID_EVENT_METADATA')
  }
  const canonical = serializeEventMetadata(value)
  if (canonical === null) throw Error('INVALID_EVENT_METADATA')
  return {
    metadata: JSON.parse(canonical) as NonNullable<SourceEvent['metadata']>,
  }
}
export function storedMetadataMatches(
  raw: unknown,
  metadata: SourceEvent['metadata'],
): boolean {
  return (
    serializeEventMetadata(eventMetadataFields(raw).metadata) ===
    serializeEventMetadata(metadata)
  )
}
export function migrateEventMetadata(db: Database.Database) {
  db.transaction(() => {
    db.exec(
      'ALTER TABLE source_events ADD COLUMN metadata_json TEXT; PRAGMA user_version=15;',
    )
  })()
}

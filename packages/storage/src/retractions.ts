import { parseContextTimestamp } from '@memo/domain'
import type Database from 'better-sqlite3'

export interface RetractionProof {
  eventId: number
  occurredAt: string
  receivedAt: string
  reasonCode: 'explicit_source_retraction'
}

export function migrateRetractions(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
    ALTER TABLE source_events ADD COLUMN operation TEXT NOT NULL DEFAULT 'upsert' CHECK(operation IN ('upsert','retract'));
    ALTER TABLE processing_evidence ADD COLUMN reference_status TEXT NOT NULL DEFAULT 'available' CHECK(reference_status IN ('available','invalidated'));
    ALTER TABLE processing_evidence ADD COLUMN invalidated_by_event_id INTEGER REFERENCES source_events(id);
    CREATE TABLE object_retractions(project_id TEXT NOT NULL,source_id TEXT NOT NULL,external_id TEXT NOT NULL,retraction_event_id INTEGER NOT NULL REFERENCES source_events(id),received_at TEXT NOT NULL,PRIMARY KEY(project_id,source_id,external_id),FOREIGN KEY(project_id,retraction_event_id) REFERENCES event_projects(project_id,event_id));
    CREATE TABLE retraction_impacts(project_id TEXT NOT NULL,retraction_event_id INTEGER NOT NULL REFERENCES source_events(id),kind TEXT NOT NULL CHECK(kind IN ('processing','manual')),evidence_id TEXT NOT NULL,prior_validity TEXT NOT NULL,PRIMARY KEY(project_id,retraction_event_id,kind,evidence_id));
    PRAGMA user_version=10;
  `),
  )()
}
export function createRetractions(db: Database.Database) {
  function forEvent(projectId: string, eventId: number) {
    const row = db
      .prepare(
        `SELECT r.retraction_event_id AS eventId,r.received_at AS recordedAt,p.occurred_at AS occurredAt,p.received_at AS receivedAt,p.operation,p.content,p.source_id AS proofSource,p.external_id AS proofExternal,e.source_id AS source,e.external_id AS external,
      EXISTS(SELECT 1 FROM event_projects ep WHERE ep.project_id=? AND ep.event_id=p.id) AS scoped
      FROM source_events e JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=? JOIN object_retractions r ON r.project_id=ep.project_id AND r.source_id=e.source_id AND r.external_id=e.external_id LEFT JOIN source_events p ON p.id=r.retraction_event_id WHERE e.id=?`,
      )
      .get(projectId, projectId, eventId) as
      | {
          eventId: number
          recordedAt: string
          occurredAt: string
          receivedAt: string
          operation: string
          content: string
          proofSource: string
          proofExternal: string
          source: string
          external: string
          scoped: number
        }
      | undefined
    if (!row) {
      const missing = db
        .prepare(
          `SELECT 1 FROM source_events e JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=? JOIN source_events r ON r.source_id=e.source_id AND r.external_id=e.external_id AND r.operation='retract' JOIN event_projects rp ON rp.event_id=r.id AND rp.project_id=ep.project_id WHERE e.id=?`,
        )
        .get(projectId, eventId)
      if (missing) throw Error('INVALID_RETRACTION_DATA')
      return null
    }
    try {
      parseContextTimestamp(row.occurredAt)
      parseContextTimestamp(row.receivedAt)
    } catch {
      throw Error('INVALID_RETRACTION_DATA')
    }
    if (
      row.operation !== 'retract' ||
      row.content !== '' ||
      row.proofSource !== row.source ||
      row.proofExternal !== row.external ||
      !row.scoped ||
      row.recordedAt !== row.receivedAt ||
      !Number.isFinite(Date.parse(row.occurredAt)) ||
      !Number.isFinite(Date.parse(row.receivedAt))
    )
      throw Error('INVALID_RETRACTION_DATA')
    return {
      eventId: row.eventId,
      occurredAt: row.occurredAt,
      receivedAt: row.receivedAt,
      reasonCode: 'explicit_source_retraction' as const,
    }
  }
  function observe(projectId: string, eventId: number) {
    const e = db
      .prepare(
        `SELECT e.* FROM source_events e JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=? WHERE e.id=? AND (
      EXISTS(SELECT 1 FROM source_grants g WHERE g.source_id=e.source_id AND g.project_id=ep.project_id AND g.revoked=0) OR
      EXISTS(SELECT 1 FROM plugin_bindings p WHERE p.source_instance_id=e.source_id AND p.project_id=ep.project_id AND p.enabled=1 AND p.uninstalled=0) OR EXISTS(SELECT 1 FROM github_connections h WHERE h.source_id=e.source_id AND h.project_id=ep.project_id AND h.enabled=1 AND h.revoked=0))`,
      )
      .get(projectId, eventId) as
      | {
          operation: string
          source_id: string
          external_id: string
          received_at: string
        }
      | undefined
    if (!e) throw Error('INVALID_RETRACTION_SCOPE')
    if (e.operation === 'retract')
      db.prepare(
        'INSERT INTO object_retractions VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
      ).run(projectId, e.source_id, e.external_id, eventId, e.received_at)
    const proof = forEvent(projectId, eventId)
    if (!proof) return
    for (const kind of ['processing', 'manual'] as const) {
      const table =
        kind === 'processing' ? 'processing_evidence' : 'evidence_links'
      const field = kind === 'processing' ? 'reference_status' : 'validity'
      const rows = db
        .prepare(
          `SELECT v.id,v.${field} AS validity FROM ${table} v JOIN source_events e ON e.id=v.event_id WHERE v.project_id=? AND e.source_id=? AND e.external_id=?`,
        )
        .all(projectId, e.source_id, e.external_id) as {
        id: string | number
        validity: string
      }[]
      for (const row of rows) {
        db.prepare(
          'INSERT INTO retraction_impacts VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
        ).run(projectId, proof.eventId, kind, String(row.id), row.validity)
        if (kind === 'processing')
          db.prepare(
            "UPDATE processing_evidence SET reference_status='invalidated',invalidated_by_event_id=? WHERE id=?",
          ).run(proof.eventId, row.id)
        else
          db.prepare(
            "UPDATE evidence_links SET validity='invalid' WHERE id=?",
          ).run(row.id)
      }
    }
  }
  return { forEvent, observe }
}

import type Database from 'better-sqlite3'
import { parseContextTimestamp } from '@memo/domain'
export interface ReferenceConflictAudit {
  id: number
  projectId: string
  taskId: string
  referenceKind: 'processing' | 'manual'
  referenceId: string
  referenceVersion: number
  triggerEventId: number | null
  previousStatus: 'available' | 'review_required' | 'confirmed' | null
  newStatus: 'review_required'
  previousDigest: string | null
  newDigest: string
  recordedAt: string
  origin: 'observed' | 'migration_snapshot'
}
export const referenceAuditProjection =
  'id,project_id AS projectId,task_id AS taskId,ref_kind AS referenceKind,ref_id AS referenceId,reference_version AS referenceVersion,trigger_event_id AS triggerEventId,previous_status AS previousStatus,new_status AS newStatus,previous_digest AS previousDigest,new_digest AS newDigest,recorded_at AS recordedAt,origin'
export function validateReferenceAudit(
  db: Database.Database,
  value: unknown,
): ReferenceConflictAudit {
  const v = value as ReferenceConflictAudit
  function fail(): never {
    throw Error('INVALID_REFERENCE_AUDIT')
  }
  const str = (x: unknown) =>
    typeof x === 'string' &&
    x.length > 0 &&
    x.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(x)
  const hash = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)
  if (
    !v ||
    typeof v !== 'object' ||
    !Number.isSafeInteger(v.id) ||
    v.id < 1 ||
    !Number.isSafeInteger(v.referenceVersion) ||
    v.referenceVersion < 1 ||
    !str(v.projectId) ||
    !str(v.taskId) ||
    !str(v.referenceId) ||
    !['processing', 'manual'].includes(v.referenceKind) ||
    v.newStatus !== 'review_required' ||
    !hash(v.newDigest) ||
    !(v.previousDigest === null || hash(v.previousDigest)) ||
    !(
      v.previousStatus === null ||
      ['available', 'review_required', 'confirmed'].includes(v.previousStatus)
    ) ||
    (v.previousStatus === null) !== (v.previousDigest === null) ||
    !['observed', 'migration_snapshot'].includes(v.origin)
  )
    fail()
  try {
    parseContextTimestamp(v.recordedAt)
  } catch {
    fail()
  }
  if (v.origin === 'migration_snapshot') {
    if (
      v.triggerEventId !== null ||
      v.previousStatus !== null ||
      v.previousDigest !== null
    )
      fail()
  } else if (
    !Number.isSafeInteger(v.triggerEventId) ||
    Number(v.triggerEventId) < 1
  )
    fail()
  const table =
    v.referenceKind === 'processing' ? 'processing_evidence' : 'evidence_links'
  const reference = db
    .prepare(
      `SELECT e.source_id,e.external_id,r.version,r.status,r.content_digest FROM ${table} x JOIN source_events e ON e.id=x.event_id JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=x.project_id JOIN reference_revision_reviews r ON r.project_id=x.project_id AND r.task_id=x.task_id AND r.reference_kind=? AND r.reference_id=CAST(x.id AS TEXT) WHERE x.project_id=? AND x.task_id=? AND CAST(x.id AS TEXT)=?`,
    )
    .get(v.referenceKind, v.projectId, v.taskId, v.referenceId) as
    | {
        source_id: string
        external_id: string
        version: number
        status: string
        content_digest: string
      }
    | undefined
  if (!reference || reference.version < v.referenceVersion) fail()
  if (
    reference.version === v.referenceVersion &&
    (reference.status !== 'review_required' ||
      reference.content_digest !== v.newDigest)
  )
    fail()
  if (v.triggerEventId !== null) {
    const trigger = db
      .prepare(
        "SELECT 1 FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id=? AND e.source_id=? AND e.external_id=? AND e.operation='upsert'",
      )
      .get(
        v.projectId,
        v.triggerEventId,
        reference.source_id,
        reference.external_id,
      )
    if (!trigger) fail()
  }
  return {
    id: v.id,
    projectId: v.projectId,
    taskId: v.taskId,
    referenceKind: v.referenceKind,
    referenceId: v.referenceId,
    referenceVersion: v.referenceVersion,
    triggerEventId: v.triggerEventId,
    previousStatus: v.previousStatus,
    newStatus: v.newStatus,
    previousDigest: v.previousDigest,
    newDigest: v.newDigest,
    recordedAt: v.recordedAt,
    origin: v.origin,
  }
}
export function recordReferenceConflict(
  db: Database.Database,
  input: Omit<ReferenceConflictAudit, 'id'>,
) {
  validateReferenceAudit(db, { ...input, id: 1 })
  db.prepare(
    'INSERT INTO reference_revision_audit(project_id,task_id,ref_kind,ref_id,reference_version,trigger_event_id,previous_status,new_status,previous_digest,new_digest,recorded_at,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    input.projectId,
    input.taskId,
    input.referenceKind,
    input.referenceId,
    input.referenceVersion,
    input.triggerEventId,
    input.previousStatus,
    input.newStatus,
    input.previousDigest,
    input.newDigest,
    input.recordedAt,
    input.origin,
  )
}
export function migrateReferenceAudit(db: Database.Database) {
  db.transaction(() => {
    db.exec(
      `CREATE TABLE reference_revision_audit(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,ref_kind TEXT NOT NULL CHECK(ref_kind IN('processing','manual')),ref_id TEXT NOT NULL,reference_version INTEGER NOT NULL CHECK(reference_version>0),trigger_event_id INTEGER REFERENCES source_events(id),previous_status TEXT CHECK(previous_status IS NULL OR previous_status IN('available','review_required','confirmed')),new_status TEXT NOT NULL CHECK(new_status='review_required'),previous_digest TEXT,new_digest TEXT NOT NULL,recorded_at TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN('observed','migration_snapshot')),UNIQUE(project_id,ref_kind,ref_id,reference_version),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(project_id,trigger_event_id) REFERENCES event_projects(project_id,event_id));CREATE INDEX reference_audit_task ON reference_revision_audit(project_id,task_id,id);`,
    )
    const recordedAt = new Date().toISOString()
    for (let offset = 0; ; offset += 500) {
      const rows = db
        .prepare(
          "SELECT project_id AS projectId,task_id AS taskId,reference_kind AS referenceKind,reference_id AS referenceId,version AS referenceVersion,content_digest AS newDigest FROM reference_revision_reviews WHERE status='review_required' ORDER BY project_id,reference_kind,reference_id LIMIT 500 OFFSET ?",
        )
        .all(offset) as Pick<
        ReferenceConflictAudit,
        | 'projectId'
        | 'taskId'
        | 'referenceKind'
        | 'referenceId'
        | 'referenceVersion'
        | 'newDigest'
      >[]
      for (const row of rows)
        recordReferenceConflict(db, {
          ...row,
          triggerEventId: null,
          previousStatus: null,
          newStatus: 'review_required',
          previousDigest: null,
          recordedAt,
          origin: 'migration_snapshot',
        })
      if (rows.length < 500) break
    }
    db.pragma('user_version=14')
  })()
}

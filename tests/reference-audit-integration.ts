import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-audit-')),
  path = join(dir, 'test.sqlite')
let store = openStore(path)
const db = new Database(path)
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const grant = store.sources.authorize({
    projectId: 'a',
    path: join(dir, 'fictional.jsonl'),
  })
  const base: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'object',
    revision: '1',
    occurredAt: '2026-09-13T09:00:00Z',
    role: 'user',
    text: '我会完成审计测试。',
  }
  const ingest = (value: SourceEvent) => {
    const g = store.sources.getAuthorized(grant.id)
    return store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [value],
      value.revision,
      g.cursor,
    )
  }
  ingest(base)
  const now = new Date('2026-09-14T00:00:00Z'),
    job = store.processing.claim(now)!,
    context = store.processing.load(job, now)!
  const taskId = store.processing.commit(
    job,
    context,
    prepareEventProcessing({
      event: context.event,
      eventId: context.eventId,
      projectId: context.projectId,
    }),
    now,
  ).taskIds[0]!
  const ref = String(
    (
      db
        .prepare('SELECT id FROM processing_evidence WHERE task_id=?')
        .get(taskId) as { id: number }
    ).id,
  )
  const input = {
    projectId: 'a',
    taskId,
    referenceKind: 'processing' as const,
    referenceId: ref,
  }
  const count = () =>
    Number(
      (
        db
          .prepare('SELECT count(*) AS n FROM reference_revision_audit')
          .get() as { n: number }
      ).n,
    )
  assert.equal(count(), 0)
  const edit = { ...base, revision: '2', text: 'PRIVATE_EDIT_BODY' }
  ingest(edit)
  assert.equal(count(), 1)
  for (let n = 0; n < 10; n++) ingest(edit)
  ingest({ ...edit, revision: 'same-content' })
  assert.equal(count(), 1)
  const first = db.prepare('SELECT * FROM reference_revision_audit').get() as {
    previous_status: string
    new_status: string
    origin: string
    trigger_event_id: number
  }
  assert.equal(first.previous_status, 'available')
  assert.equal(first.new_status, 'review_required')
  assert.equal(first.origin, 'observed')
  const review = store.revisionReview.reviewReference(input)
  store.revisionReview.confirmReference(
    {
      ...input,
      chosenEventId: first.trigger_event_id,
      knownContentSetDigest: review.knownContentSetDigest,
      expectedReferenceVersion: review.reference.version,
      reason: 'Read the revised source',
    },
    'local-user',
  )
  ingest({ ...base, revision: '3', text: 'PRIVATE_EDIT_BODY_3' })
  assert.equal(count(), 2)
  assert.equal(
    (
      db
        .prepare(
          'SELECT previous_status FROM reference_revision_audit ORDER BY id DESC LIMIT 1',
        )
        .get() as { previous_status: string }
    ).previous_status,
    'confirmed',
  )
  const cursor = store.sources.getAuthorized(grant.id).cursor,
    events = store.health().eventCount
  db.exec(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON reference_revision_audit BEGIN SELECT RAISE(ABORT,'audit failure'); END",
  )
  assert.throws(
    () => ingest({ ...base, revision: '4', text: 'PRIVATE_ROLLBACK_BODY' }),
    /audit failure/,
  )
  assert.equal(store.health().eventCount, events)
  assert.equal(store.sources.getAuthorized(grant.id).cursor, cursor)
  assert.equal(count(), 2)
  db.exec('DROP TRIGGER fail_audit')
  const exported = store.exports.build({
    projectId: 'a',
    includeSourceText: false,
  })
  assert.equal(exported.schemaVersion, 7)
  assert.equal(exported.referenceConflictAudit.length, 2)
  assert.ok(exported.events.some((e) => e.id === first.trigger_event_id))
  assert.equal(JSON.stringify(exported).includes('PRIVATE_EDIT_BODY'), false)
  assert.ok(
    JSON.stringify(
      store.exports.build({ projectId: 'a', includeSourceText: true }),
    ).includes('PRIVATE_EDIT_BODY'),
  )
  db.prepare(
    "UPDATE reference_revision_audit SET recorded_at='not-time' WHERE id=1",
  ).run()
  assert.throws(
    () => store.exports.build({ projectId: 'a', includeSourceText: false }),
    /EXPORT_CORRUPT_DATA/,
  )
  db.prepare(
    'UPDATE reference_revision_audit SET recorded_at=? WHERE id=1',
  ).run(new Date().toISOString())
  store.close()
  db.exec(
    'ALTER TABLE github_connections DROP COLUMN error_scope; ALTER TABLE github_connections DROP COLUMN mode; DROP TABLE task_merges; DROP TABLE task_splits; DROP TABLE plan_change_assessments; DROP TABLE source_association_audit; DROP TABLE explicit_identity_mappings; DROP TABLE task_source_anchors; DROP TABLE source_object_bindings; DROP TABLE plan_change_proposals; ALTER TABLE source_events DROP COLUMN metadata_json; DROP TABLE reference_revision_audit; PRAGMA user_version=13',
  )
  const migrationStart = Date.now()
  store = openStore(path)
  assert.equal(count(), 1)
  const snapshot = db
    .prepare(
      'SELECT origin,trigger_event_id,previous_status,previous_digest,recorded_at FROM reference_revision_audit',
    )
    .get() as {
    origin: string
    trigger_event_id: number | null
    previous_status: null
    previous_digest: null
    recorded_at: string
  }
  assert.equal(snapshot.origin, 'migration_snapshot')
  assert.equal(snapshot.trigger_event_id, null)
  assert.equal(snapshot.previous_status, null)
  assert.equal(snapshot.previous_digest, null)
  assert.ok(Date.parse(snapshot.recorded_at) >= migrationStart)
  assert.equal(
    store.exports.build({ projectId: 'a', includeSourceText: false })
      .referenceConflictAudit[0]!.origin,
    'migration_snapshot',
  )
  ingest({ ...base, revision: '5', text: 'new change after migration' })
  assert.equal(count(), 2)
  assert.equal(store.health().schemaVersion, 21)
  console.log('Reference conflict audit integration passed')
} finally {
  db.close()
  store.close()
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
}

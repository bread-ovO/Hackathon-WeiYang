import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import type { SourceEvent } from '@memo/contracts'
const folder = mkdtempSync(join(tmpdir(), 'bugu-event-context-'))
const path = join(folder, 'context.sqlite')
let store: ReturnType<typeof openStore> | undefined
try {
  store = openStore(path)
  store.tasks.createProject('alpha', '同名项目')
  store.tasks.createProject('beta', '同名项目')
  const alpha = store.sources.authorize({
    projectId: 'alpha',
    path: join(folder, 'same.jsonl'),
  })
  const beta = store.sources.authorize({
    projectId: 'beta',
    path: join(folder, 'same.jsonl'),
  })
  const event: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: alpha.id,
    externalId: 'same-message',
    revision: '1',
    occurredAt: '2026-09-13T09:00:00+08:00',
    role: 'user',
    text: '同名人物明确改期',
  }
  store.sources.receiveBatch(alpha.id, alpha.grantVersion, [event], 'a1', '')
  store.sources.receiveBatch(
    beta.id,
    beta.grantVersion,
    [{ ...event, sourceInstanceId: beta.id }],
    'b1',
    '',
  )
  const db = new Database(path)
  const id = (
    db
      .prepare('SELECT id FROM source_events WHERE source_id=?')
      .get(alpha.id) as { id: number }
  ).id
  const betaId = (
    db
      .prepare('SELECT id FROM source_events WHERE source_id=?')
      .get(beta.id) as { id: number }
  ).id
  const first = store.contexts.get('alpha', id)!
  assert.equal(first.time!.occurred.utc, '2026-09-13T01:00:00.000000000Z')
  assert.equal(first.time!.occurred.offsetMinutes, 480)
  assert.equal(first.time!.sourceTimeZone, null)
  assert.equal(first.identity!.namespace, 'source-event')
  assert.equal(first.identity!.projectId, 'alpha')
  assert.equal(store.contexts.get('beta', id), null)
  assert.notEqual(
    first.identity!.key,
    store.contexts.get('beta', betaId)!.identity!.key,
  )
  // Even an explicitly shared event remains scoped separately in each project.
  store.tasks.assignEvent('beta', id)
  assert.notEqual(
    first.identity!.key,
    store.contexts.get('beta', id)!.identity!.key,
  )
  store.sources.receiveBatch(alpha.id, alpha.grantVersion, [event], 'a2', 'a1')
  assert.deepEqual(store.contexts.get('alpha', id), first)
  assert.equal(
    (
      db.prepare('SELECT COUNT(*) AS n FROM event_contexts').get() as {
        n: number
      }
    ).n,
    2,
  )
  // Invalid context fails inside the same source transaction, including cursor and jobs.
  assert.throws(
    () =>
      store!.sources.receiveBatch(
        alpha.id,
        alpha.grantVersion,
        [
          {
            ...event,
            externalId: 'bad',
            occurredAt: '2026-09-13T09:00:00-00:00',
          },
        ],
        'bad',
        'a2',
      ),
    /INVALID_SOURCE_EVENT/,
  )
  assert.equal(store.cursor(alpha.id), 'a2')
  assert.equal(store.health().eventCount, 2)
  assert.equal(store.health().jobCount, 2)
  store.close()
  store = openStore(path)
  assert.deepEqual(store.contexts.get('alpha', id), first)
  // Reconstruct a legacy v6 database. Valid times backfill; invalid ones stay unavailable.
  store.close()
  store = undefined
  db.exec('DROP TABLE plan_change_assessments; DROP TABLE source_association_audit; DROP TABLE explicit_identity_mappings; DROP TABLE task_source_anchors; DROP TABLE source_object_bindings; DROP TABLE plan_change_proposals; ALTER TABLE source_events DROP COLUMN metadata_json; DROP TABLE reference_revision_audit; DROP TABLE feishu_page_tokens; DROP TABLE feishu_credential_cooldowns; DROP TABLE feishu_connections; DROP TABLE github_credential_cooldowns; DROP TABLE github_connections; DROP TABLE reference_revision_decisions; DROP TABLE reference_revision_reviews; DROP TABLE retraction_impacts; DROP TABLE object_retractions; ALTER TABLE source_events DROP COLUMN operation; DROP TABLE ingestion_limits; DROP TABLE processing_decisions; DROP TABLE processing_evidence; DROP TABLE processing_origins; DROP TABLE processing_results; DROP TABLE processing_preferences; ALTER TABLE jobs DROP COLUMN processing_skips; DROP TABLE event_contexts; PRAGMA user_version=6;')
  db.prepare('UPDATE source_events SET occurred_at=? WHERE id=?').run(
    '2026-02-30T10:00:00Z',
    betaId,
  )
  db.close()
  store = openStore(path)
  assert.equal(store.health().schemaVersion, 18)
  assert.deepEqual(store.contexts.get('alpha', id), first)
  const old = store.contexts.get('beta', betaId)!
  assert.equal(old.status, 'invalid_legacy_time')
  assert.equal(old.time, null)
  assert.equal(store.health().eventCount, 2)
  // The old unknown-offset timestamp passes the v1 schema but cannot be ordered.
  // Its exact replay must not replace the original context or create a new job.
  store.close()
  store = undefined
  const legacy = new Database(path)
  legacy
    .prepare('UPDATE source_events SET occurred_at=? WHERE id=?')
    .run('2026-09-13T09:00:00-00:00', betaId)
  legacy.exec('DROP TABLE plan_change_assessments; DROP TABLE source_association_audit; DROP TABLE explicit_identity_mappings; DROP TABLE task_source_anchors; DROP TABLE source_object_bindings; DROP TABLE plan_change_proposals; ALTER TABLE source_events DROP COLUMN metadata_json; DROP TABLE reference_revision_audit; DROP TABLE feishu_page_tokens; DROP TABLE feishu_credential_cooldowns; DROP TABLE feishu_connections; DROP TABLE github_credential_cooldowns; DROP TABLE github_connections; DROP TABLE reference_revision_decisions; DROP TABLE reference_revision_reviews; DROP TABLE retraction_impacts; DROP TABLE object_retractions; ALTER TABLE source_events DROP COLUMN operation; DROP TABLE ingestion_limits; DROP TABLE processing_decisions; DROP TABLE processing_evidence; DROP TABLE processing_origins; DROP TABLE processing_results; DROP TABLE processing_preferences; ALTER TABLE jobs DROP COLUMN processing_skips; DROP TABLE event_contexts; PRAGMA user_version=6;')
  legacy.close()
  store = openStore(path)
  store.sources.receiveBatch(
    beta.id,
    beta.grantVersion,
    [
      {
        ...event,
        sourceInstanceId: beta.id,
        occurredAt: '2026-09-13T09:00:00-00:00',
      },
    ],
    'b2',
    'b1',
  )
  assert.equal(
    store.contexts.get('beta', betaId)!.status,
    'invalid_legacy_time',
  )
  assert.equal(store.health().jobCount, 2)
  // SourceEvent v1 permits whitespace/control in opaque IDs: never silently trim them.
  store.sources.receiveBatch(
    alpha.id,
    alpha.grantVersion,
    [{ ...event, externalId: ' legacy\u0001 ' }],
    'a3',
    'a2',
  )
  const lookup = new Database(path)
  const legacyId = (
    lookup
      .prepare('SELECT id FROM source_events WHERE external_id=?')
      .get(' legacy\u0001 ') as { id: number }
  ).id
  lookup.close()
  const unavailable = store.contexts.get('alpha', legacyId)!
  assert.equal(unavailable.identity, null)
  assert.equal(unavailable.identityStatus, 'invalid_source_identity')
  assert.equal(unavailable.time!.occurred.utc, first.time!.occurred.utc)
  console.log('Event context integration passed')
} finally {
  store?.close()
  rmSync(folder, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
import { createRetractions } from '../packages/storage/src/retractions'
const dir = mkdtempSync(join(tmpdir(), 'bugu-retract-'))
const path = join(dir, 'test.sqlite')
const store = openStore(path)
const db = new Database(path)
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const grant = store.sources.authorize({
    path: join(dir, 'fictional.jsonl'),
    projectId: 'a',
  })
  const base: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'object',
    revision: '1',
    occurredAt: '2026-09-13T09:00:00Z',
    role: 'user',
    text: '我会提交修复 PR。',
  }
  const ingest = (event: SourceEvent) => {
    const g = store.sources.getAuthorized(grant.id)
    return store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [event],
      'cursor-' + event.revision,
      g.cursor,
    )
  }
  const now = new Date('2026-09-14T09:00:00Z')
  const process = () => {
    const job = store.processing.claim(now)!
    assert.ok(job)
    const c = store.processing.load(job, now)!
    return store.processing.commit(
      job,
      c,
      prepareEventProcessing({
        event: c.event,
        eventId: c.eventId,
        projectId: c.projectId,
      }),
      now,
    )
  }
  ingest(base)
  const initial = process()
  const id = initial.taskIds[0]!
  const taskBefore = store.tasks.get('a', id)
  const originalEventId = (
    db.prepare('SELECT id FROM source_events WHERE revision=?').get('1') as {
      id: number
    }
  ).id
  db.prepare('INSERT INTO criterion_sets VALUES(?,1)').run(id)
  db.prepare(
    "INSERT INTO criteria VALUES(?,'a',1,'c','Fictional criterion',NULL)",
  ).run(id)
  db.prepare(
    "INSERT INTO evidence_links VALUES('manual-link',?,'a',1,'c',?,'supports','valid','Human original reason')",
  ).run(id, originalEventId)
  db.prepare(
    "UPDATE processing_evidence SET reference_status='invalidated' WHERE task_id=?",
  ).run(id)
  assert.throws(
    () => store.processing.getTaskEvidence('a', id),
    /INVALID_RETRACTION_DATA/,
  )
  db.prepare(
    "UPDATE processing_evidence SET reference_status='available' WHERE task_id=?",
  ).run(id)
  store.processing.setEnabled(false)
  const retract: SourceEvent = {
    ...base,
    revision: '2',
    operation: 'retract',
    text: '',
  }
  db.exec(
    "CREATE TRIGGER reject_retract BEFORE INSERT ON object_retractions BEGIN SELECT RAISE(ABORT,'fixture'); END",
  )
  const cursorBefore = store.sources.getAuthorized(grant.id).cursor
  assert.throws(() => ingest(retract), /fixture/)
  assert.equal(store.sources.getAuthorized(grant.id).cursor, cursorBefore)
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM source_events WHERE operation='retract'",
        )
        .get() as { n: number }
    ).n,
    0,
  )
  db.exec('DROP TRIGGER reject_retract')
  ingest(retract)
  assert.deepEqual(
    db
      .prepare(
        "SELECT validity,reason FROM evidence_links WHERE id='manual-link'",
      )
      .get(),
    { validity: 'invalid', reason: 'Human original reason' },
  )
  assert.equal(
    store.processing.getTaskEvidence('a', id)[0]!.referenceStatus,
    'invalidated',
  )
  assert.deepEqual(store.tasks.get('a', id), taskBefore)
  for (let i = 0; i < 10; i++) ingest(retract)
  assert.equal(
    (
      db.prepare('SELECT count(*) AS n FROM object_retractions').get() as {
        n: number
      }
    ).n,
    1,
  )
  assert.equal(
    (
      db.prepare('SELECT count(*) AS n FROM retraction_impacts').get() as {
        n: number
      }
    ).n,
    2,
  )
  assert.throws(
    () => ingest({ ...base, revision: '2', text: '' }),
    /SOURCE_REVISION_CONFLICT/,
  )
  const eventId = (
    db.prepare('SELECT id FROM source_events WHERE revision=?').get('1') as {
      id: number
    }
  ).id
  assert.equal(createRetractions(db).forEvent('b', eventId), null)
  store.processing.setEnabled(true)
  assert.equal(process().outcome, 'review_required')
  ingest({ ...base, revision: 'late' })
  assert.equal(process().outcome, 'review_required')
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
    1,
  )
  ingest({ ...retract, externalId: 'before', revision: 'r' })
  process()
  ingest({ ...base, externalId: 'before', revision: 'u' })
  assert.equal(process().outcome, 'review_required')
  assert.equal(
    (db.prepare('SELECT count(*) AS n FROM tasks').get() as { n: number }).n,
    1,
  )
  const proof = createRetractions(db).forEvent('a', eventId)!
  db.prepare(
    'UPDATE processing_evidence SET invalidated_by_event_id=? WHERE task_id=?',
  ).run(eventId, id)
  assert.throws(
    () => store.processing.getTaskEvidence('a', id),
    /INVALID_RETRACTION_DATA/,
  )
  db.prepare(
    'UPDATE processing_evidence SET invalidated_by_event_id=? WHERE task_id=?',
  ).run(proof.eventId, id)
  const publicReference = store.processing.getTaskEvidence('a', id)[0]!
  assert.equal(Object.hasOwn(publicReference, 'storedReferenceStatus'), false)
  assert.equal(Object.hasOwn(publicReference, 'storedInvalidatedBy'), false)
  db.prepare('DELETE FROM object_retractions WHERE external_id=?').run('object')
  assert.throws(
    () => createRetractions(db).forEvent('a', eventId),
    /INVALID_RETRACTION_DATA/,
  )
  console.log('retraction integration passed')
} finally {
  db.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

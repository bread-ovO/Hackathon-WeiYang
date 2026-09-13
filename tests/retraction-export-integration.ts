import { openStore, type StoredTask } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(tmpdir(), 'bugu-retraction-export-'))
const path = join(root, 'fixture.sqlite')
const store = openStore(path)
const by = { actorId: 'fictional-user', reason: '明确人工决定' }
const expected = (task: StoredTask) => ({
  projectId: task.projectId!,
  taskId: task.id,
  expectedVersion: task.version,
  expectedCriteriaVersion: task.criteriaVersion,
  expectedManualVersion: task.manualVersion,
})
try {
  store.tasks.createProject('p', '虚构撤回项目')
  store.tasks.createProject('other', '其他项目')
  const source = store.sources.authorize({
    projectId: 'p',
    path: join(root, 'FICTIONAL_PRIVATE_PATH.jsonl'),
  })
  const event: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: source.id,
    externalId: 'message',
    revision: '1',
    occurredAt: '2026-09-13T10:00:00Z',
    role: 'user',
    text: '我会提交虚构撤回报告。',
  }
  store.sources.receiveBatch(source.id, source.grantVersion, [event], '1', '')
  const job = store.processing.claim()!
  const context = store.processing.load(job)!
  const result = store.processing.commit(
    job,
    context,
    prepareEventProcessing({
      event: context.event,
      eventId: context.eventId,
      projectId: context.projectId,
    }),
  )
  const taskId = result.taskIds[0]!
  let task = store.tasks.get('p', taskId)!
  store.tasks.replaceCriteria(
    expected(task),
    [
      {
        id: 'criterion',
        description: '等待真实人工验收',
        originEventId: context.eventId,
      },
    ],
    by,
  )
  task = store.tasks.get('p', taskId)!
  store.tasks.addEvidence(
    expected(task),
    {
      id: 'manual-reference',
      criterionId: 'criterion',
      criteriaVersion: task.criteriaVersion,
      eventId: context.eventId,
      relation: 'supports',
      validity: 'valid',
      reason: '明确引用',
    },
    by,
  )
  task = store.tasks.get('p', taskId)!
  store.tasks.update(
    expected(task),
    { title: '人工保留的事项', status: 'completed' },
    by,
  )
  const before = store.tasks.get('p', taskId)!
  store.processing.setEnabled(false)
  store.sources.receiveBatch(
    source.id,
    source.grantVersion,
    [{ ...event, revision: '2', operation: 'retract', text: '' }],
    '2',
    '1',
  )
  // Export must reflect retraction immediately, without running the paused consumer.
  const scope = { projectId: 'p', taskIds: [taskId], includeSourceText: true }
  const full = store.exports.build(scope)
  assert.equal(full.schemaVersion, 4)
  assert.deepEqual(full.tasks[0], before)
  const reference = full.candidateEvidence[0]!
  assert.equal(reference.referenceStatus, 'invalidated')
  assert.equal(reference.quote, event.text)
  assert.equal(reference.retraction?.reasonCode, 'explicit_source_retraction')
  assert.equal(full.evidence[0]!.validity, 'invalid')
  assert.equal(full.evidence[0]!.referenceStatus, 'invalidated')
  assert.equal(full.events.length, 2)
  assert.equal(
    full.events.find((e) => e.operation === 'retract')!.id,
    reference.retraction!.eventId,
  )
  assert.ok(
    full.events.every(
      (e) => e.eventStatus === 'retracted' && e.sourceStatus === 'active',
    ),
  )
  assert.equal(full.retractionImpacts.length, 2)
  assert.equal(full.decisions.at(-1)!.actor, 'manual')
  const redacted = store.exports.build({ ...scope, includeSourceText: false })
  assert.ok(redacted.events.every((e) => !('text' in e)))
  assert.ok(redacted.candidateEvidence.every((e) => !('quote' in e)))
  assert.ok(!JSON.stringify(redacted).includes(event.text))
  assert.ok(!JSON.stringify(redacted).includes('FICTIONAL_PRIVATE_PATH'))
  assert.equal(redacted.retractionImpacts.length, 2)
  assert.throws(
    () => store.exports.build({ ...scope, projectId: 'other' }),
    /EXPORT_TASK_NOT_IN_PROJECT/,
  )
  store.processing.setEnabled(true)
  const retractJob = store.processing.claim()!
  const retractContext = store.processing.load(retractJob)!
  store.processing.commit(
    retractJob,
    retractContext,
    prepareEventProcessing({
      event: retractContext.event,
      eventId: retractContext.eventId,
      projectId: retractContext.projectId,
    }),
  )
  const audited = store.exports.build(scope)
  assert.ok(
    audited.ruleDecisions.some(
      (d) =>
        d.reason === 'source_retracted' &&
        d.eventId === reference.retraction!.eventId,
    ),
  )
  assert.deepEqual(audited.tasks[0], before)
  assert.equal(audited.events.length, 2)
  store.sources.revoke(source.id)
  assert.ok(
    store.exports
      .build(scope)
      .events.every(
        (e) => e.sourceStatus === 'revoked' && e.eventStatus === 'retracted',
      ),
  )
  const raw = new Database(path)
  try {
    raw
      .prepare('UPDATE object_retractions SET retraction_event_id=?')
      .run(context.eventId)
    assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
    raw
      .prepare('UPDATE object_retractions SET retraction_event_id=?')
      .run(reference.retraction!.eventId)
    raw
      .prepare(
        "UPDATE processing_evidence SET reference_status='available',invalidated_by_event_id=NULL",
      )
      .run()
    assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
  } finally {
    raw.close()
  }
  console.log(
    'Retraction export integration passed: immediate invalidation, proof closure, human state, privacy, source independence and corruption rejection',
  )
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}

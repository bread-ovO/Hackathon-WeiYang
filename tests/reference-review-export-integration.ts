import { openStore, type StoredTask } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(tmpdir(), 'bugu-reference-export-'))
const store = openStore(join(root, 'fixture.sqlite'))
const expected = (t: StoredTask) => ({
  projectId: t.projectId!,
  taskId: t.id,
  expectedVersion: t.version,
  expectedCriteriaVersion: t.criteriaVersion,
  expectedManualVersion: t.manualVersion,
})
const actor = { actorId: 'fictional-human', reason: '明确人工核验' }
try {
  store.tasks.createProject('p', '虚构版本项目')
  store.tasks.createProject('other', '其他项目')
  const source = store.sources.authorize({
    projectId: 'p',
    path: join(root, 'fictional.jsonl'),
  })
  let cursor = ''
  const event: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: source.id,
    externalId: 'object',
    revision: '1',
    occurredAt: '2026-09-13T10:00:00Z',
    role: 'user',
    text: '我会提交原始版本报告。',
  }
  const ingest = (
    revision: string,
    text: string,
    operation: 'upsert' | 'retract' = 'upsert',
  ) => {
    const next = cursor + 'x'
    store.sources.receiveBatch(
      source.id,
      source.grantVersion,
      [{ ...event, revision, text, operation }],
      next,
      cursor,
    )
    cursor = next
  }
  ingest('1', event.text)
  const job = store.processing.claim()!,
    context = store.processing.load(job)!
  const taskId = store.processing.commit(
    job,
    context,
    prepareEventProcessing({
      event: context.event,
      eventId: context.eventId,
      projectId: 'p',
    }),
  ).taskIds[0]!
  let task = store.tasks.get('p', taskId)!
  store.tasks.replaceCriteria(
    expected(task),
    [{ id: 'c', description: '人工检查文档', originEventId: context.eventId }],
    actor,
  )
  task = store.tasks.get('p', taskId)!
  store.tasks.addEvidence(
    expected(task),
    {
      id: 'manual',
      criterionId: 'c',
      criteriaVersion: task.criteriaVersion,
      eventId: context.eventId,
      relation: 'supports',
      validity: 'valid',
      reason: '人工引用原版本',
    },
    actor,
  )
  const before = store.tasks.get('p', taskId)!
  const scope = { projectId: 'p', taskIds: [taskId], includeSourceText: true }
  const original = store.exports.build(scope)
  const referenceId = String(original.candidateEvidence[0]!.id)
  const processing = {
    projectId: 'p',
    taskId,
    referenceKind: 'processing' as const,
    referenceId,
  }
  const manual = {
    projectId: 'p',
    taskId,
    referenceKind: 'manual' as const,
    referenceId: 'manual',
  }
  store.processing.setEnabled(false)
  const changed = '我会提交经过修改的版本报告。'
  ingest('2', changed)
  const conflict = store.exports.build(scope)
  assert.equal(conflict.schemaVersion, 7)
  assert.ok(
    conflict.referenceReviews.every(
      (r) => r.reference.status === 'review_required',
    ),
  )
  assert.equal(conflict.candidateEvidence[0]!.referenceStatus, 'invalidated')
  assert.equal(conflict.evidence[0]!.validity, 'invalid')
  assert.equal(conflict.events.length, 2)
  const select = (
    input: typeof processing | typeof manual,
    revision: string,
  ) => {
    const view = store.revisionReview.reviewReference(input)
    const chosen = view.events.find((e) => e.revision === revision)!
    return store.revisionReview.confirmReference(
      {
        ...input,
        chosenEventId: chosen.id,
        expectedReferenceVersion: view.reference.version,
        knownContentSetDigest: view.knownContentSetDigest,
        reason: '我已核对，选择使用该版本',
      },
      'local-user',
    )
  }
  select(processing, '2')
  const selected = store.exports.build(scope)
  assert.equal(selected.candidateEvidence[0]!.quote, event.text)
  assert.equal(selected.candidateEvidence[0]!.referenceStatus, 'invalidated')
  assert.equal(
    selected.referenceReviews.find((r) => r.reference.kind === 'processing')!
      .confirmation!.text,
    changed,
  )
  assert.equal(
    selected.referenceReviews.find((r) => r.reference.kind === 'manual')!
      .reference.status,
    'review_required',
  )
  assert.deepEqual(selected.tasks[0], before)
  select(manual, '2')
  const manualSelected = store.exports.build(scope)
  assert.equal(manualSelected.evidence[0]!.validity, 'invalid')
  assert.equal(
    manualSelected.referenceReviews.find((r) => r.reference.kind === 'manual')!
      .confirmation!.validity,
    'valid',
  )
  assert.equal(manualSelected.referenceDecisions.length, 2)
  const redacted = store.exports.build({ ...scope, includeSourceText: false })
  assert.ok(
    redacted.referenceReviews.every(
      (r) => !r.confirmation || !('text' in r.confirmation),
    ),
  )
  assert.ok(redacted.events.every((e) => !('text' in e)))
  assert.ok(redacted.candidateEvidence.every((e) => !('quote' in e)))
  assert.ok(!JSON.stringify(redacted).includes(changed))
  assert.ok(!JSON.stringify(redacted).includes(event.text))
  ingest('3', changed)
  assert.ok(
    store.exports
      .build(scope)
      .referenceReviews.every((r) => r.reference.status === 'confirmed'),
  )
  const stale = store.revisionReview.reviewReference(manual)
  ingest('4', '我会提交第三种内容的报告。')
  assert.throws(
    () =>
      store.revisionReview.confirmReference(
        {
          ...manual,
          chosenEventId: context.eventId,
          expectedReferenceVersion: stale.reference.version,
          knownContentSetDigest: stale.knownContentSetDigest,
          reason: '旧页面请求',
        },
        'local-user',
      ),
    /REFERENCE_REVIEW_CONFLICT/,
  )
  const newer = store.exports.build(scope)
  assert.ok(
    newer.referenceReviews.every(
      (r) =>
        r.reference.status === 'review_required' && r.confirmation === null,
    ),
  )
  assert.equal(newer.referenceDecisions.length, 2)
  assert.equal(newer.events.length, 4)
  select(manual, '1')
  assert.equal(store.exports.build(scope).evidence[0]!.validity, 'valid')
  ingest('5', '', 'retract')
  const retracted = store.exports.build(scope)
  assert.ok(
    retracted.referenceReviews.every(
      (r) => r.reference.status === 'invalidated',
    ),
  )
  assert.equal(
    retracted.referenceReviews.find((r) => r.reference.kind === 'manual')!
      .confirmation!.validity,
    'invalid',
  )
  assert.equal(retracted.events.length, 5)
  assert.deepEqual(retracted.tasks[0], before)
  assert.throws(
    () => store.exports.build({ ...scope, projectId: 'other' }),
    /EXPORT_TASK_NOT_IN_PROJECT/,
  )
  console.log(
    'Reference review export integration passed: conflict, selected content, privacy, original quote, independent references, stale confirmation and retraction precedence',
  )
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}

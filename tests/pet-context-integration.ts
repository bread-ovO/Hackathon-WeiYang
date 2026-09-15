import { commitHistoricalFixture } from './fixtures/legacy-rule-task'
import { prepareEventProcessing } from '@memo/application'
import { openStore } from '@memo/storage'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
const root = mkdtempSync(join(tmpdir(), 'bugu-pet-facts-')),
  file = join(root, 'db.sqlite'),
  store = openStore(file),
  raw = new Database(file)
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('p', '项目')
  store.tasks.createProject('q', '另一项目')
  const grant = store.sources.authorize({
    projectId: 'p',
    path: join(root, 'synthetic.jsonl'),
  })
  let cursor = ''
  const send = (
    revision: string,
    text: string,
    operation: 'upsert' | 'retract' = 'upsert',
  ) => {
    store.sources.receiveBatch(
      grant.id,
      grant.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: grant.id,
          externalId: 'e',
          revision,
          occurredAt: '2026-09-13T00:00:00Z',
          role: 'user',
          text,
          operation,
        },
      ],
      revision,
      cursor,
    )
    cursor = revision
  }
  send('1', '私人来源片段，不可出现在桌宠事实或模型请求。')
  const actor = { actorId: 'fixture', reason: '人工维护' }
  let task = store.tasks.create(
    { id: 't', projectId: 'p', title: '真实事项标题', admission: 'accepted' },
    actor,
  )
  const expected = () => ({
    projectId: 'p',
    taskId: 't',
    expectedVersion: task.version,
    expectedCriteriaVersion: task.criteriaVersion,
    expectedManualVersion: task.manualVersion,
  })
  task = store.tasks.replaceCriteria(
    expected(),
    [{ id: 'c', description: '人工检查' }],
    actor,
  )
  task = store.tasks.addEvidence(
    expected(),
    {
      id: 'evidence',
      criterionId: 'c',
      criteriaVersion: task.criteriaVersion,
      eventId: 1,
      relation: 'supports',
      validity: 'unknown',
      reason: '尚未知',
    },
    actor,
  )
  assert.deepEqual(store.petContext.facts(['p']).facts, [])
  // A second current valid evidence enables a stored-state fact, without claiming completion.
  task = store.tasks.addEvidence(
    expected(),
    {
      id: 'valid',
      criterionId: 'c',
      criteriaVersion: task.criteriaVersion,
      eventId: 1,
      relation: 'supports',
      validity: 'valid',
      reason: '已核对来源',
    },
    actor,
  )
  const fact = store.petContext.facts(['p']).facts[0]!
  assert.equal(fact.title, task.title)
  assert.equal(fact.status, 'todo')
  assert.equal(fact.eventId, 1)
  assert.equal(store.petContext.validate(fact), true)
  assert.equal(JSON.stringify(fact).includes('私人来源'), false)
  assert.equal(store.petContext.facts(['q']).facts.length, 0)
  assert.equal(store.petContext.validate({ ...fact, projectId: 'q' }), false)
  assert.equal(
    store.petContext.validate({ ...fact, title: '模型编造标题' }),
    false,
  )
  assert.equal(
    store.petContext.validate({ ...fact, proof: '0'.repeat(64) }),
    false,
  )
  task = store.tasks.update(expected(), { status: 'completed' }, actor)
  assert.equal(store.petContext.validate(fact), false)
  const completed = store.petContext.facts(['p']).facts[0]!
  assert.equal(completed.status, 'completed') // Actual manual state; no evidence-completion inference.
  task = store.tasks.update(expected(), { archived: true }, actor)
  assert.equal(store.petContext.validate(completed), false)
  assert.equal(store.petContext.facts(['p']).facts.length, 0)
  task = store.tasks.update(expected(), { archived: false }, actor)
  const beforeEdit = store.petContext.facts(['p']).facts[0]!
  send('2', '已修改来源，旧引用需要重新核对。')
  assert.equal(store.petContext.validate(beforeEdit), false)
  assert.equal(store.petContext.facts(['p']).facts.length, 0)
  const scope = {
    projectId: 'p',
    taskId: 't',
    referenceKind: 'manual' as const,
    referenceId: 'valid',
  }
  const review = store.revisionReview.reviewReference(scope)
  store.revisionReview.confirmReference(
    {
      ...scope,
      chosenEventId: 2,
      knownContentSetDigest: review.knownContentSetDigest,
      expectedReferenceVersion: review.reference.version,
      reason: '人工选择已知版本',
    },
    'fixture',
  )
  const confirmed = store.petContext.facts(['p']).facts[0]!
  assert.equal(confirmed.eventId, 2)
  assert.equal(store.petContext.validate(confirmed), true)
  store.sources.revoke(grant.id)
  assert.equal(store.petContext.validate(confirmed), false)
  assert.equal(store.petContext.facts(['p']).facts.length, 0)
  const renewed = store.sources.authorize({
    projectId: 'p',
    path: join(root, 'synthetic.jsonl'),
  })
  assert.equal(store.petContext.validate(confirmed), false)
  const renewedFact = store.petContext.facts(['p']).facts[0]!
  assert.equal(store.petContext.validate(renewedFact), true)
  store.sources.receiveBatch(
    grant.id,
    renewed.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: grant.id,
        externalId: 'e',
        revision: '3',
        occurredAt: '2026-09-13T00:00:00Z',
        role: 'user',
        text: '',
        operation: 'retract',
      },
    ],
    '3',
    '2',
  )
  assert.equal(store.petContext.validate(renewedFact), false)
  assert.equal(store.petContext.facts(['p']).facts.length, 0)
  assert.throws(() => store.petContext.facts(['missing']))
  assert.throws(() => store.petContext.facts(['p', 'p']))
  // An unrelated source event cannot be substituted for the referenced object.
  assert.equal(
    store.petContext.validate({ ...renewedFact, eventId: 999 }),
    false,
  )
  const savedDigest = (
    raw
      .prepare(
        "SELECT content_digest FROM reference_revision_reviews WHERE reference_id='valid'",
      )
      .get() as { content_digest: string }
  ).content_digest
  raw
    .prepare(
      "UPDATE reference_revision_reviews SET content_digest='bad' WHERE reference_id='valid'",
    )
    .run()
  assert.throws(() => store.petContext.facts(['p']), /PET_CONTEXT_UNAVAILABLE/)
  raw
    .prepare(
      "UPDATE reference_revision_reviews SET content_digest=? WHERE reference_id='valid'",
    )
    .run(savedDigest)
  const qsource = store.sources.authorize({
    projectId: 'q',
    path: join(root, 'q.jsonl'),
  })
  store.sources.receiveBatch(
    qsource.id,
    qsource.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: qsource.id,
        externalId: 'commitment',
        revision: '1',
        occurredAt: '2026-09-13T00:00:00Z',
        role: 'user',
        text: '我会提交测试报告。',
      },
    ],
    '1',
    '',
  )
  store.processing.setEnabled(true)
  for (let i = 0; i < 20; i++) {
    const lease = store.processing.claim()
    if (!lease) break
    const context = store.processing.load(lease)!
    commitHistoricalFixture(
      store,
      file,
      lease,
      context,
      prepareEventProcessing({
        event: context.event,
        eventId: context.eventId,
        projectId: context.projectId,
      }),
    )
  }
  let candidate = store.tasks.list('q')[0]!
  assert.equal(store.petContext.facts(['q']).facts.length, 0)
  const accept = () => ({
    projectId: 'q',
    taskId: candidate.id,
    expectedVersion: candidate.version,
    expectedCriteriaVersion: candidate.criteriaVersion,
    expectedManualVersion: candidate.manualVersion,
  })
  candidate = store.tasks.update(accept(), { admission: 'accepted' }, actor)
  const ruleFact = store.petContext.facts(['q']).facts[0]!
  assert.ok(ruleFact.referenceId.startsWith('processing:'))
  assert.equal(store.petContext.validate(ruleFact), true)
  candidate = store.tasks.update(accept(), { title: '界'.repeat(121) }, actor)
  assert.equal(store.petContext.facts(['q']).facts.length, 0)
  candidate = store.tasks.update(accept(), { title: '😀'.repeat(120) }, actor)
  assert.equal(store.petContext.facts(['q']).facts.length, 1)
  raw
    .prepare('UPDATE processing_evidence SET quote=? WHERE task_id=?')
    .run('不是原文', candidate.id)
  assert.equal(store.petContext.validate(ruleFact), false)
  assert.throws(() => store.petContext.facts(['q']), /PET_CONTEXT_UNAVAILABLE/)
  candidate = store.tasks.update(accept(), { title: '长'.repeat(121) }, actor)
  const qEvent = (
    raw
      .prepare('SELECT id FROM source_events WHERE source_id=?')
      .get(qsource.id) as { id: number }
  ).id
  for (let i = 0; i < 5; i++) {
    let t = store.tasks.create(
      {
        id: `limit-${i}`,
        projectId: 'q',
        title: `事项${i}`,
        admission: 'accepted',
      },
      actor,
    )
    const expectedLimit = () => ({
      projectId: 'q',
      taskId: t.id,
      expectedVersion: t.version,
      expectedCriteriaVersion: t.criteriaVersion,
      expectedManualVersion: t.manualVersion,
    })
    t = store.tasks.replaceCriteria(
      expectedLimit(),
      [{ id: 'current', description: '核对事实' }],
      actor,
    )
    t = store.tasks.addEvidence(
      expectedLimit(),
      {
        id: `limit-ref-${i}`,
        criterionId: 'current',
        criteriaVersion: t.criteriaVersion,
        eventId: qEvent,
        relation: 'opposes',
        validity: 'valid',
        reason: '反证仍可定位事项事实',
      },
      actor,
    )
  }
  assert.equal(store.petContext.facts(['q']).facts.length, 3)
  assert.deepEqual(store.petContext.facts(['q']), store.petContext.facts(['q']))
  console.log(
    'Pet facts integration passed: strict facts/unknown, task and archive changes, confirmed variants, reauthorization, retraction, scope and corruption',
  )
} finally {
  raw.close()
  store.close()
  try {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  } catch {}
}

import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
const root = mkdtempSync(join(tmpdir(), 'bugu-plan-association-')),
  file = join(root, 'db.sqlite'),
  store = openStore(file),
  raw = new Database(file)
try {
  store.tasks.createProject('p', '项目')
  store.tasks.createProject('other', '项目')
  const a = store.sources.authorize({
      projectId: 'p',
      path: join(root, 'a.jsonl'),
    }),
    b = store.sources.authorize({ projectId: 'p', path: join(root, 'b.jsonl') })
  const cursors = new Map<string, string>()
  function send(
    source: typeof a,
    externalId: string,
    text: string,
    at: string,
    author: string,
    reply?: string,
  ) {
    const cursor = String(Number(cursors.get(source.id) ?? '0') + 1)
    store.sources.receiveBatch(
      source.id,
      source.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: source.id,
          externalId,
          revision: '1',
          role: 'user',
          occurredAt: at,
          text,
          metadata: {
            author: { namespace: 'synthetic-user', subjectId: author },
            ...(reply ? { replyToExternalId: reply } : {}),
          },
        },
      ],
      cursor,
      cursors.get(source.id) ?? '',
    )
    cursors.set(source.id, cursor)
    return (
      raw
        .prepare(
          'SELECT id FROM source_events WHERE source_id=? AND external_id=?',
        )
        .get(source.id, externalId) as { id: number }
    ).id
  }
  function drain() {
    for (let n = 0; n < 100; n++) {
      const lease = store.processing.claim()
      if (!lease) return
      const c = store.processing.load(lease)!
      store.processing.commit(
        lease,
        c,
        prepareEventProcessing({
          event: c.event,
          eventId: c.eventId,
          projectId: c.projectId,
        }),
      )
    }
    throw Error('LOOP')
  }
  const ea = send(
      a,
      'root',
      '明确来源对象 A',
      '2026-09-13T00:00:00Z',
      'alice-a',
    ),
    eb = send(b, 'root-b', '明确来源对象 B', '2026-09-13T00:01:00Z', 'alice-b')
  const old = send(
    b,
    'old-plan',
    '截止时间改为 2026-09-20T10:00:00Z',
    '2026-09-13T00:02:00Z',
    'alice-b',
    'root-b',
  )
  drain()
  let task = store.tasks.create(
    {
      id: 'manual-task',
      projectId: 'p',
      title: '人工事项',
      admission: 'accepted',
    },
    { actorId: 'fixture', reason: '创建' },
  )
  const expected = () => ({
    expectedTaskVersion: task.version,
    expectedCriteriaVersion: task.criteriaVersion,
    expectedManualVersion: task.manualVersion,
  })
  const bind = (eventId: number) =>
    store.sourceAssociations.bindSourceObject(
      {
        projectId: 'p',
        taskId: task.id,
        eventId,
        ...expected(),
        reason: '人工关联',
      },
      'fixture',
    )
  bind(ea)
  bind(eb)
  const bindings = store.sourceAssociations.sourceBindings({
    projectId: 'p',
    taskId: task.id,
  }).bindings
  const ba = bindings.find((x) => x.sourceInstanceId === a.id)!,
    bb = bindings.find((x) => x.sourceInstanceId === b.id)!
  const evaluate = (eventId: number) =>
    store.planChanges.reevaluate(
      {
        projectId: 'p',
        taskId: task.id,
        eventId,
        expectedVersion: task.version,
        expectedCriteriaVersion: task.criteriaVersion,
        expectedManualVersion: task.manualVersion,
        reason: '只重新评估所选事件',
      },
      'fixture',
    )
  const first = evaluate(old)
  assert.equal(first.guard, 'identity_mismatch')
  assert.equal(first.assessmentVersion, 1)
  store.sourceAssociations.confirmIdentityMapping(
    {
      projectId: 'p',
      taskId: task.id,
      leftEventId: ea,
      rightEventId: eb,
      expectedMappingVersion: 0,
      expectedLeftBindingVersion: ba.version,
      expectedRightBindingVersion: bb.version,
      reason: '确认本人账户',
    },
    'fixture',
  )
  // Existing proposal must be explicitly reevaluated; mapping never silently grants it a fresh fence.
  assert.equal(
    store.planChanges.list({ projectId: 'p', taskId: task.id }).proposals[0]!
      .guard,
    'identity_mismatch',
  )
  const second = evaluate(old)
  assert.equal(second.guard, 'ready')
  assert.equal(second.assessmentVersion, 2)
  const confirm = (p: typeof first) =>
    store.planChanges.confirm(
      {
        projectId: 'p',
        taskId: task.id,
        proposalId: p.id,
        expectedAssessmentVersion: p.assessmentVersion,
        expectedVersion: p.taskVersion,
        expectedCriteriaVersion: p.criteriaVersion,
        expectedManualVersion: p.manualVersion,
        reason: '确认截止调整',
      },
      'fixture',
    )
  assert.throws(() => confirm(first), /VERSION_CONFLICT/)
  const beforeCount = (
    raw.prepare('SELECT COUNT(*) n FROM processing_results').get() as {
      n: number
    }
  ).n
  task = confirm(second)
  assert.equal(task.dueAt, '2026-09-20T10:00:00.000Z')
  assert.equal(
    (
      raw.prepare('SELECT COUNT(*) n FROM processing_results').get() as {
        n: number
      }
    ).n,
    beforeCount,
  )
  // New actual consumer event on source B has same external ID as source A baseline: scope prevents collision.
  send(
    b,
    'root',
    '截止时间改为 2026-09-21T10:00:00Z',
    '2026-09-13T00:03:00Z',
    'alice-b',
    'root-b',
  )
  drain()
  const live = store.planChanges.list({ projectId: 'p', taskId: task.id })
    .proposals[0]!
  assert.equal(live.guard, 'ready')
  assert.equal(live.assessmentVersion, 1)
  // A later commitment on an explicitly bound object must not create a second task.
  const boundEvent = send(
    a,
    'bound-revision',
    '已关联的独立对象',
    '2026-09-13T00:04:00Z',
    'alice-a',
  )
  store.sourceAssociations.bindSourceObject(
    {
      projectId: 'p',
      taskId: task.id,
      eventId: boundEvent,
      expectedTaskVersion: task.version,
      expectedCriteriaVersion: task.criteriaVersion,
      expectedManualVersion: task.manualVersion,
      reason: '关联第三个对象',
    },
    'fixture',
  )
  const nextCursor = String(Number(cursors.get(a.id)!) + 1)
  store.sources.receiveBatch(
    a.id,
    a.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: a.id,
        externalId: 'bound-revision',
        revision: '2',
        role: 'user',
        occurredAt: '2026-09-13T00:05:00Z',
        text: '我会提交新报告。',
        metadata: {
          author: { namespace: 'synthetic-user', subjectId: 'alice-a' },
        },
      },
    ],
    nextCursor,
    cursors.get(a.id)!,
  )
  cursors.set(a.id, nextCursor)
  drain()
  assert.equal(store.tasks.list('p').length, 1)
  assert.equal(
    (
      raw
        .prepare(
          "SELECT COUNT(*) n FROM processing_origins WHERE external_id='bound-revision'",
        )
        .get() as { n: number }
    ).n,
    0,
  )
  assert.equal(
    (
      raw
        .prepare(
          "SELECT outcome FROM processing_results WHERE event_id=(SELECT id FROM source_events WHERE source_id=? AND external_id='bound-revision' AND revision='2')",
        )
        .get(a.id) as { outcome: string }
    ).outcome,
    'review_required',
  )
  const assessmentCount = (
    raw.prepare('SELECT COUNT(*) n FROM plan_change_assessments').get() as {
      n: number
    }
  ).n
  raw.exec(
    "CREATE TRIGGER assessment_fault BEFORE INSERT ON plan_change_assessments BEGIN SELECT RAISE(ABORT,'synthetic assessment failure'); END",
  )
  assert.throws(() => evaluate(live.eventId), /synthetic assessment failure/)
  raw.exec('DROP TRIGGER assessment_fault')
  assert.equal(
    (
      raw.prepare('SELECT COUNT(*) n FROM plan_change_assessments').get() as {
        n: number
      }
    ).n,
    assessmentCount,
  )
  assert.equal(
    store.planChanges.list({ projectId: 'p', taskId: task.id }).proposals[0]!
      .assessmentVersion,
    live.assessmentVersion,
  )
  const map = store.sourceAssociations.identityMappings({
    projectId: 'p',
    taskId: task.id,
  }).mappings[0]!
  store.sourceAssociations.revokeIdentityMapping(
    {
      projectId: 'p',
      taskId: task.id,
      id: map.id,
      expectedVersion: map.version,
      reason: '撤销账户映射',
    },
    'fixture',
  )
  assert.equal(
    store.planChanges.list({ projectId: 'p', taskId: task.id }).proposals[0]!
      .guard,
    'mapping_changed',
  )
  assert.throws(() => confirm(live), /NOT_APPLICABLE/)
  store.sourceAssociations.revokeSourceBinding(
    {
      projectId: 'p',
      taskId: task.id,
      id: bb.id,
      expectedVersion: bb.version,
      reason: '撤销来源关联',
    },
    'fixture',
  )
  assert.equal(
    store.planChanges.list({ projectId: 'p', taskId: task.id }).proposals[0]!
      .guard,
    'association_changed',
  )
  const audit = store.planChanges.exportAssessmentsForTasks('p', [task.id])
  assert.equal(audit.length, 3)
  assert.equal(audit[0]!.actorKind, 'manual')
  assert.equal(audit[2]!.actorKind, 'rule')
  assert.equal(audit[1]!.before!.assessmentVersion, 1)
  assert.throws(
    () =>
      store.planChanges.reevaluate(
        {
          projectId: 'other',
          taskId: task.id,
          eventId: old,
          expectedVersion: task.version,
          expectedCriteriaVersion: task.criteriaVersion,
          expectedManualVersion: task.manualVersion,
          reason: '错误项目',
        },
        'fixture',
      ),
    /NOT_FOUND/,
  )
  // A fabricated direct-author success cannot turn a previously unmatched cross-source proof into authorization.
  const originalProof = (
    raw
      .prepare('SELECT proof FROM plan_change_assessments WHERE id=?')
      .get(audit[0]!.id) as { proof: string }
  ).proof
  const corrupt = JSON.parse(originalProof)
  corrupt.authorLinks[0].matched = true
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(JSON.stringify(corrupt), audit[0]!.id)
  assert.throws(
    () => store.planChanges.getAudit('p', task.id, audit[0]!.id),
    /NOT_APPLICABLE/,
  )
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(originalProof, audit[0]!.id)
  const mappedProof = (
    raw
      .prepare('SELECT proof FROM plan_change_assessments WHERE id=?')
      .get(audit[1]!.id) as { proof: string }
  ).proof
  const revokedMapProof = JSON.parse(mappedProof)
  revokedMapProof.authorLinks[0].mappingVersion = 2
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(JSON.stringify(revokedMapProof), audit[1]!.id)
  assert.throws(
    () => store.planChanges.getAudit('p', task.id, audit[1]!.id),
    /NOT_APPLICABLE/,
  )
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(mappedProof, audit[1]!.id)
  // Third-source dependency: C depends on B's applied chronology, not only A's primary anchor.
  const c = store.sources.authorize({
    projectId: 'p',
    path: join(root, 'c.jsonl'),
  })
  const ta = send(a, 'triple-a', '对象甲', '2026-09-13T16:00:00Z', 'carol-a'),
    tb = send(b, 'triple-b', '对象乙', '2026-09-13T16:01:00Z', 'carol-b'),
    tc = send(c, 'triple-c', '对象丙', '2026-09-13T16:02:00Z', 'carol-c')
  drain()
  let triple = store.tasks.create(
    {
      id: 'triple-task',
      projectId: 'p',
      title: '三来源事项',
      admission: 'accepted',
    },
    { actorId: 'fixture', reason: '创建三来源测试' },
  )
  for (const eventId of [ta, tb, tc])
    store.sourceAssociations.bindSourceObject(
      {
        projectId: 'p',
        taskId: triple.id,
        eventId,
        expectedTaskVersion: triple.version,
        expectedCriteriaVersion: triple.criteriaVersion,
        expectedManualVersion: triple.manualVersion,
        reason: '关联三来源',
      },
      'fixture',
    )
  const tripleBindings = store.sourceAssociations.sourceBindings({
    projectId: 'p',
    taskId: triple.id,
  }).bindings
  const byEvent = (eventId: number) =>
    tripleBindings.find((x) => x.baselineEventId === eventId)!
  for (const [leftEventId, rightEventId] of [
    [ta, tb],
    [ta, tc],
    [tb, tc],
  ])
    store.sourceAssociations.confirmIdentityMapping(
      {
        projectId: 'p',
        taskId: triple.id,
        leftEventId: leftEventId!,
        rightEventId: rightEventId!,
        expectedLeftBindingVersion: byEvent(leftEventId!).version,
        expectedRightBindingVersion: byEvent(rightEventId!).version,
        expectedMappingVersion: 0,
        reason: '人工确认直接身份对',
      },
      'fixture',
    )
  send(
    b,
    'triple-b-plan',
    '截止时间改为 2026-09-23T10:00:00Z',
    '2026-09-13T16:03:00Z',
    'carol-b',
    'triple-b',
  )
  drain()
  const bp = store.planChanges.list({ projectId: 'p', taskId: triple.id })
    .proposals[0]!
  assert.equal(bp.guard, 'ready')
  triple = store.planChanges.confirm(
    {
      projectId: 'p',
      taskId: triple.id,
      proposalId: bp.id,
      expectedAssessmentVersion: bp.assessmentVersion,
      expectedVersion: bp.taskVersion,
      expectedCriteriaVersion: bp.criteriaVersion,
      expectedManualVersion: bp.manualVersion,
      reason: '应用B计划',
    },
    'fixture',
  )
  send(
    c,
    'triple-c-plan',
    '截止时间改为 2026-09-24T10:00:00Z',
    '2026-09-13T16:04:00Z',
    'carol-c',
    'triple-c',
  )
  drain()
  const cp = store.planChanges.list({ projectId: 'p', taskId: triple.id })
    .proposals[0]!
  assert.equal(cp.guard, 'ready')
  const tripleAudits = store.planChanges.exportAssessmentsForTasks('p', [
      triple.id,
    ]),
    ca = tripleAudits.find((x) => x.proposalId === cp.id)!
  assert.equal(ca.proof.bindings.length, 3)
  // Unrelated same-author current event cannot be forged into a historical proof.
  const saved = (
    raw
      .prepare('SELECT proof FROM plan_change_assessments WHERE id=?')
      .get(ca.id) as { proof: string }
  ).proof
  const unrelated = JSON.parse(saved)
  unrelated.currentEventId = tb
  unrelated.authorLinks = unrelated.authorLinks.map(
    (x: { leftEventId: number }) =>
      x.leftEventId === bp.eventId ? { ...x, leftEventId: tb } : x,
  )
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(JSON.stringify(unrelated), ca.id)
  assert.throws(
    () => store.planChanges.getAudit('p', triple.id, ca.id),
    /NOT_APPLICABLE/,
  )
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(saved, ca.id)
  store.sourceAssociations.revokeSourceBinding(
    {
      projectId: 'p',
      taskId: triple.id,
      id: byEvent(tb).id,
      expectedVersion: byEvent(tb).version,
      reason: '撤销当前B依据',
    },
    'fixture',
  )
  assert.equal(
    store.planChanges.list({ projectId: 'p', taskId: triple.id }).proposals[0]!
      .guard,
    'association_changed',
  )
  assert.equal(
    store.planChanges.exportAssessmentsForTasks('p', [triple.id]).length,
    2,
  )
  // Historical audit may retain real active v1, but must reject a forged revoked v2 fence.
  const forged = JSON.parse(saved)
  forged.bindings[2].version = 2
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(JSON.stringify(forged), ca.id)
  assert.throws(
    () => store.planChanges.getAudit('p', triple.id, ca.id),
    /NOT_APPLICABLE/,
  )
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(saved, ca.id)
  console.log(
    'Plan association integration passed: manual task, direct identity mapping, explicit selected-event reassessment, background hook, composite scope, audit CAS and revocation',
  )
} finally {
  raw.close()
  store.close()
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
}

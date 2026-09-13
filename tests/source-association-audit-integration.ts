import type { TimelinePage } from '@memo/contracts'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
const root = mkdtempSync(join(tmpdir(), 'bugu-source-audit-')),
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
  const scope = { projectId: 'p', taskId: task.id }
  const history = store.timeline.list({ ...scope, limit: 50 })
  assert.equal(
    history.entries.filter((e) => e.kind === 'source_binding').length,
    2,
  )
  assert.equal(
    history.entries.filter((e) => e.kind === 'identity_mapping').length,
    1,
  )
  assert.equal(
    history.entries.filter((e) => e.kind === 'plan_assessment').length,
    2,
  )
  const manual = history.entries.find(
    (e) => e.kind === 'manual' && e.changes.some((c) => c.field === 'dueAt'),
  )!
  assert.ok(manual)
  assert.deepEqual(manual.relatedEventIds, [old])
  assert.equal(manual.evidence!.eventId, old)
  const redacted = store.exports.build({
    projectId: 'p',
    taskIds: [task.id],
    includeSourceText: false,
  })
  assert.equal(redacted.schemaVersion, 7)
  assert.equal(redacted.sourceBindings.length, 2)
  assert.equal(redacted.identityMappings.length, 1)
  assert.equal(redacted.associationAudit.length, 3)
  assert.equal(redacted.planAssessments.length, 2)
  assert.ok(redacted.events.every((e) => e.text === undefined))
  assert.ok(redacted.planChangeProposals.every((p) => p.quote === null))
  for (const id of [ea, eb, old])
    assert.ok(redacted.events.some((e) => e.id === id))
  const full = store.exports.build({
    projectId: 'p',
    taskIds: [task.id],
    includeSourceText: true,
  })
  assert.equal(
    full.events.find((e) => e.id === old)!.text,
    '截止时间改为 2026-09-20T10:00:00Z',
  )
  const firstPage = store.timeline.list({ ...scope, limit: 1 })
  const cursor = firstPage.nextCursor!
  assert.ok(cursor)
  const mapping = store.sourceAssociations.identityMappings(scope).mappings[0]!
  const reuseTask = store.tasks.create(
    { id: 'reuse-task', projectId: 'p', title: '另一事项' },
    { actorId: 'fixture', reason: '复用同项目身份映射' },
  )
  const reuseA = send(
    a,
    'reuse-a',
    '同一发送者另一对象A',
    '2026-09-13T03:00:00Z',
    'alice-a',
  )
  const reuseB = send(
    b,
    'reuse-b',
    '同一发送者另一对象B',
    '2026-09-13T03:01:00Z',
    'alice-b',
  )
  for (const eventId of [reuseA, reuseB])
    store.sourceAssociations.bindSourceObject(
      {
        projectId: 'p',
        taskId: reuseTask.id,
        eventId,
        expectedTaskVersion: reuseTask.version,
        expectedCriteriaVersion: reuseTask.criteriaVersion,
        expectedManualVersion: reuseTask.manualVersion,
        reason: '该对象属于另一事项',
      },
      'fixture',
    )
  assert.equal(
    store.sourceAssociations.identityMappings({
      projectId: 'p',
      taskId: reuseTask.id,
    }).mappings[0]!.id,
    mapping.id,
  )
  store.sourceAssociations.revokeIdentityMapping(
    {
      ...scope,
      taskId: reuseTask.id,
      id: mapping.id,
      expectedVersion: mapping.version,
      reason: '撤销不代表撤销已人工改期',
    },
    'fixture',
  )
  const fresh = store.timeline.list({ ...scope, limit: 50 })
  const revoke = fresh.entries.find(
    (e) =>
      e.kind === 'identity_mapping' &&
      e.changes.some(
        (c) => c.field === 'mappingStatus' && c.after === 'revoked',
      ),
  )!
  assert.ok(revoke)
  const afterRevoke = store.exports.build({
    projectId: 'p',
    taskIds: [task.id],
    includeSourceText: false,
  })
  assert.ok(
    afterRevoke.associationAudit.some(
      (a) =>
        a.taskId === reuseTask.id &&
        a.entityId === mapping.id &&
        a.action === 'revoke',
    ),
  )
  assert.equal(afterRevoke.tasks.length, 1)
  let next: string | null = cursor
  const olderKeys = new Set(firstPage.entries.map((e) => e.key))
  while (next) {
    const page: TimelinePage = store.timeline.list({
      ...scope,
      cursor: next,
      limit: 2,
    })
    page.entries.forEach((e) => {
      assert.ok(!olderKeys.has(e.key))
      olderKeys.add(e.key)
    })
    next = page.nextCursor
  }
  assert.equal(olderKeys.has(revoke.key), false)
  assert.equal(olderKeys.size, history.entries.length)
  // v1 cursors from pre-association releases retain their original five-family snapshot.
  const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  const legacy = Buffer.from(
    JSON.stringify({
      ...c,
      v: 1,
      ceil: c.ceil.slice(0, 5),
      after: {
        at: '9999-12-31T23:59:59.999Z',
        rank: 4,
        id: Number.MAX_SAFE_INTEGER,
      },
    }),
  ).toString('base64url')
  const legacyPage = store.timeline.list({
    ...scope,
    cursor: legacy,
    limit: 50,
  })
  assert.ok(
    legacyPage.entries.every(
      (e) =>
        !['source_binding', 'identity_mapping', 'plan_assessment'].includes(
          e.kind,
        ),
    ),
  )
  const bindingAudit = raw
    .prepare(
      "SELECT * FROM source_association_audit WHERE kind='source_binding' ORDER BY id LIMIT 1",
    )
    .get() as Record<string, unknown>
  const alteredBinding = JSON.parse(bindingAudit.after_json as string)
  alteredBinding.primary = !alteredBinding.primary
  raw
    .prepare('UPDATE source_association_audit SET after_json=? WHERE id=?')
    .run(JSON.stringify(alteredBinding), bindingAudit.id)
  assert.throws(
    () => store.timeline.list({ ...scope, limit: 50 }),
    /TIMELINE_CORRUPT_DATA/,
  )
  assert.throws(
    () =>
      store.exports.build({
        projectId: 'p',
        taskIds: [task.id],
        includeSourceText: false,
      }),
    /EXPORT_CORRUPT_DATA/,
  )
  raw
    .prepare('UPDATE source_association_audit SET after_json=? WHERE id=?')
    .run(bindingAudit.after_json, bindingAudit.id)
  const auditRow = raw
    .prepare('SELECT * FROM source_association_audit ORDER BY id DESC LIMIT 1')
    .get() as Record<string, unknown>
  raw
    .prepare('UPDATE source_association_audit SET after_json=? WHERE id=?')
    .run('{"token":"NO_LEAK"}', auditRow.id)
  assert.throws(
    () => store.timeline.list({ ...scope, limit: 50 }),
    /TIMELINE_CORRUPT_DATA/,
  )
  assert.throws(
    () =>
      store.exports.build({
        projectId: 'p',
        taskIds: [task.id],
        includeSourceText: false,
      }),
    /EXPORT_CORRUPT_DATA/,
  )
  raw
    .prepare('UPDATE source_association_audit SET after_json=? WHERE id=?')
    .run(auditRow.after_json, auditRow.id)
  const assessment = raw
    .prepare('SELECT * FROM plan_change_assessments ORDER BY id DESC LIMIT 1')
    .get() as Record<string, unknown>
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run('{"token":"NO_LEAK"}', assessment.id)
  assert.throws(
    () => store.timeline.list({ ...scope, limit: 50 }),
    /TIMELINE_CORRUPT_DATA/,
  )
  assert.throws(
    () =>
      store.exports.build({
        projectId: 'p',
        taskIds: [task.id],
        includeSourceText: false,
      }),
    /EXPORT_CORRUPT_DATA/,
  )
  raw
    .prepare('UPDATE plan_change_assessments SET proof=? WHERE id=?')
    .run(assessment.proof, assessment.id)
  assert.equal(store.tasks.get('p', task.id)!.dueAt, '2026-09-20T10:00:00.000Z')
  console.log(
    'Source association audit integration passed: real confirmation, combined timeline, snapshot cursors, export privacy and corruption',
  )
} finally {
  raw.close()
  store.close()
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
}

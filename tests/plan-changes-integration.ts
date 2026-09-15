import { commitHistoricalFixture } from './fixtures/legacy-rule-task'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(tmpdir(), 'bugu-plans-')),
  path = join(root, 'db.sqlite')
const store = openStore(path)
const raw = new Database(path)
try {
  store.tasks.createProject('a', '相同项目名')
  store.tasks.createProject('b', '相同项目名')
  const source = store.sources.authorize({
    projectId: 'a',
    path: join(root, 'synthetic.jsonl'),
  })
  let cursor = 0
  function receive(
    externalId: string,
    text: string,
    occurredAt: string,
    options: Partial<SourceEvent> = {},
  ) {
    const e: SourceEvent = {
      schemaVersion: 1,
      sourceInstanceId: source.id,
      externalId,
      revision: '1',
      role: 'user',
      occurredAt,
      text,
      ...options,
    }
    store.sources.receiveBatch(
      source.id,
      source.grantVersion,
      [e],
      String(++cursor),
      String(cursor - 1) || '',
    )
  }
  // cursor starts empty in a fresh grant.
  function first() {
    store.sources.receiveBatch(
      source.id,
      source.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: source.id,
          externalId: 'origin',
          metadata: {
            author: {
              namespace: 'feishu-open-id',
              subjectId: 'synthetic-user',
            },
          },
          revision: '1',
          role: 'user',
          occurredAt: '2026-09-13T00:00:00Z',
          text: '我会提交虚构报告。',
        },
      ],
      '1',
      '',
    )
    cursor = 1
  }
  function drain() {
    for (let i = 0; i < 100; i++) {
      const lease = store.processing.claim()
      if (!lease) return
      const c = store.processing.load(lease)!
      commitHistoricalFixture(
        store,
        path,
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
  first()
  drain()
  const task = store.tasks.list('a')[0]!
  const due = (day: number) => `截止时间改为 2026-09-${day}T10:00:00Z`
  const reply = {
    metadata: {
      replyToExternalId: 'origin',
      author: { namespace: 'feishu-open-id', subjectId: 'synthetic-user' },
    },
  }
  receive('reply1', due(20), '2026-09-13T01:00:00Z', reply)
  drain()
  let proposals = store.planChanges.list({
    projectId: 'a',
    taskId: task.id,
  }).proposals
  assert.equal(proposals.length, 1)
  assert.equal(proposals[0]!.guard, 'ready')
  assert.equal(store.tasks.get('a', task.id)!.dueAt, null)
  const confirm = (p: (typeof proposals)[number]) =>
    store.planChanges.confirm(
      {
        projectId: 'a',
        taskId: task.id,
        proposalId: p.id,
        expectedAssessmentVersion: p.assessmentVersion,
        expectedVersion: p.taskVersion,
        expectedCriteriaVersion: p.criteriaVersion,
        expectedManualVersion: p.manualVersion,
        reason: '人工确认虚构改期',
      },
      'fixture-user',
    )
  const updated = confirm(proposals[0]!)
  assert.equal(updated.dueAt, '2026-09-20T10:00:00.000Z')
  assert.equal(updated.status, task.status)
  assert.throws(() => confirm(proposals[0]!), /NOT_APPLICABLE/)
  const audit = raw
    .prepare("SELECT input_refs FROM decisions WHERE reason='人工确认虚构改期'")
    .get() as { input_refs: string }
  assert.equal(JSON.parse(audit.input_refs).length, 1)
  receive('late', due(21), '2026-09-13T00:30:00Z', reply)
  drain()
  proposals = store.planChanges.list({
    projectId: 'a',
    taskId: task.id,
  }).proposals
  assert.equal(proposals[0]!.guard, 'late_occurrence')
  assert.throws(() => confirm(proposals[0]!), /NOT_APPLICABLE/)
  receive('new', due(22), '2026-09-13T02:00:00Z', reply)
  drain()
  const fresh = store.planChanges.list({ projectId: 'a', taskId: task.id })
    .proposals[0]!
  assert.equal(fresh.guard, 'ready')
  // Editing a proposal source invalidates its older exact quoted proposal, even before jobs run.
  receive('new', '改期提议已编辑，尚未确认。', '2026-09-13T02:01:00Z', {
    revision: '2',
    ...reply,
  })
  assert.equal(
    store.planChanges.list({ projectId: 'a', taskId: task.id }).proposals[0]!
      .guard,
    'reference_invalidated',
  )
  assert.throws(() => confirm(fresh), /NOT_APPLICABLE/)
  drain()
  receive('revoked', due(23), '2026-09-13T03:00:00Z', reply)
  drain()
  const revoked = store.planChanges.list({ projectId: 'a', taskId: task.id })
    .proposals[0]!
  store.sources.revoke(source.id)
  assert.equal(
    store.planChanges.list({ projectId: 'a', taskId: task.id }).proposals[0]!
      .guard,
    'source_unavailable',
  )
  assert.throws(() => confirm(revoked), /NOT_APPLICABLE/)
  assert.throws(
    () => store.planChanges.list({ projectId: 'b', taskId: task.id }),
    /NOT_FOUND/,
  )
  const exported = store.planChanges.exportForTasks('a', [task.id], false)
  assert.ok(exported.length >= 4)
  assert.ok(exported.every((e) => e.quote === null))
  assert.equal(
    store.planChanges
      .exportForTasks('a', [task.id], true)
      .find((p) => p.id === fresh.id)!.quote,
    fresh.quote,
  )
  // Failed mutation transaction cannot leave an audit row or changed deadline.
  const grant = store.sources.authorize({
    projectId: 'a',
    path: join(root, 'synthetic.jsonl'),
  })
  store.sources.receiveBatch(
    source.id,
    grant.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: source.id,
        externalId: 'retract',
        revision: '1',
        role: 'user',
        occurredAt: '2026-09-13T04:00:00Z',
        text: due(24),
        ...reply,
      },
    ],
    'next',
    String(cursor),
  )
  drain()
  const retract = store.planChanges.list({ projectId: 'a', taskId: task.id })
    .proposals[0]!
  store.sources.receiveBatch(
    source.id,
    grant.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: source.id,
        externalId: 'retract',
        revision: '2',
        role: 'user',
        occurredAt: '2026-09-13T04:01:00Z',
        text: '',
        operation: 'retract',
      },
    ],
    'end',
    'next',
  )
  assert.equal(
    store.planChanges.list({ projectId: 'a', taskId: task.id }).proposals[0]!
      .guard,
    'retracted',
  )
  assert.throws(() => confirm(retract), /NOT_APPLICABLE/)
  assert.equal(store.tasks.get('a', task.id)!.dueAt, '2026-09-20T10:00:00.000Z')
  // Separate synthetic origin: missing or mismatched author is never treated as the same person.
  const author = { namespace: 'feishu-open-id', subjectId: 'synthetic-user' }
  let next = 0,
    previousCursor = 'end'
  const send = (
    externalId: string,
    text: string,
    metadata: SourceEvent['metadata'],
    revision = '1',
  ) => {
    const nextCursor = `case-${++next}`
    store.sources.receiveBatch(
      source.id,
      grant.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: source.id,
          externalId,
          revision,
          role: 'user',
          occurredAt: `2026-09-13T05:${String(next).padStart(2, '0')}:00Z`,
          text,
          ...(metadata ? { metadata } : {}),
        },
      ],
      nextCursor,
      previousCursor,
    )
    previousCursor = nextCursor
    drain()
  }
  send('legacy-origin', '我会提交另一份报告。', undefined)
  const legacyTask = store.tasks.list('a').find((t) => t.id !== task.id)!
  send('legacy-plan', due(25), { replyToExternalId: 'legacy-origin', author })
  assert.equal(
    store.planChanges.list({ projectId: 'a', taskId: legacyTask.id })
      .proposals[0]!.guard,
    'identity_unknown',
  )
  send('wrong-person', due(25), {
    replyToExternalId: 'origin',
    author: { namespace: author.namespace, subjectId: 'other-person' },
  })
  assert.equal(
    store.planChanges.list({ projectId: 'a', taskId: task.id }).proposals[0]!
      .guard,
    'identity_mismatch',
  )
  send('metadata-plan', due(25), { replyToExternalId: 'origin', author })
  const metadataPlan = store.planChanges.list({
    projectId: 'a',
    taskId: task.id,
  }).proposals[0]!
  assert.equal(metadataPlan.guard, 'ready')
  send(
    'metadata-plan',
    due(25),
    {
      replyToExternalId: 'origin',
      author: { namespace: author.namespace, subjectId: 'other-person' },
    },
    '2',
  )
  assert.equal(
    store.planChanges
      .list({ projectId: 'a', taskId: task.id })
      .proposals.find((p) => p.id === metadataPlan.id)!.guard,
    'reference_invalidated',
  )
  // A write failure after manual task update rolls the whole confirmation back.
  send('rollback-plan', due(26), { replyToExternalId: 'origin', author })
  const rollback = store.planChanges.list({ projectId: 'a', taskId: task.id })
    .proposals[0]!
  const versions = store.tasks.get('a', task.id)!
  raw.exec(
    "CREATE TRIGGER fail_plan_confirm BEFORE UPDATE OF applied_at ON plan_change_proposals BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
  )
  assert.throws(() => confirm(rollback), /synthetic rollback/)
  assert.deepEqual(store.tasks.get('a', task.id), versions)
  assert.equal(
    store.planChanges.list({ projectId: 'a', taskId: task.id }).proposals[0]!
      .status,
    'pending',
  )
  raw.exec('DROP TRIGGER fail_plan_confirm')
  for (const patch of [
    { cursor: 'x'.repeat(4097) },
    { cursor: '***' },
    { limit: 51 },
    { path: '/untrusted' },
  ])
    assert.throws(
      () =>
        store.planChanges.list({ projectId: 'a', taskId: task.id, ...patch }),
      /INVALID_INPUT/,
    )
  // Corrupt applied audit links fail closed, instead of presenting an invented applied history.
  const firstApplied = raw
    .prepare(
      'SELECT id,decision_id FROM plan_change_proposals WHERE applied_at IS NOT NULL LIMIT 1',
    )
    .get() as { id: number; decision_id: number }
  raw
    .prepare("UPDATE decisions SET input_refs='[]' WHERE id=?")
    .run(firstApplied.decision_id)
  assert.throws(
    () => store.planChanges.list({ projectId: 'a', taskId: task.id }),
    /NOT_APPLICABLE/,
  )
  console.log(
    'Plan change integration passed: real processing commit, quote/CAS/audit, late arrival, edited source, retraction, revocation and export privacy',
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

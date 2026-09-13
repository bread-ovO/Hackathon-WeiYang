import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-delivery-')),
  path = join(dir, 'test.sqlite'),
  db = new Database(path)
let store = openStore(path)
const by = { actorId: 'synthetic', reason: '核对约定' },
  root = 'https://github.com/example/demo',
  issue = root + '/issues/1',
  pull = root + '/pull/2'
const expected = (id: string, p = 'p') => {
  const t = store.tasks.get(p, id)!
  return {
    projectId: p,
    taskId: id,
    expectedTaskVersion: t.version,
    expectedCriteriaVersion: t.criteriaVersion,
    expectedManualVersion: t.manualVersion,
  }
}
const view = (id = 'task') => store.delivery.view('p', id)
const resolve = (
  eventId: number,
  id = 'task',
  decision: 'confirm' | 'reject' = 'confirm',
) =>
  store.delivery.resolve({
    ...expected(id),
    eventId,
    decision,
    expectedDigest: view(id).digest,
  })
function process() {
  const now = new Date('2026-10-01T00:00:00Z')
  for (let n = 0; n < 100; n++) {
    const j = store.processing.claim(now)
    if (!j) return
    const c = store.processing.load(j, now)!
    store.processing.commit(
      j,
      c,
      prepareEventProcessing({
        event: c.event,
        eventId: c.eventId,
        projectId: c.projectId,
      }),
      now,
    )
  }
  throw Error('job loop')
}
try {
  for (const p of ['p', 'q']) store.tasks.createProject(p, p)
  const g = store.github.authorize({
      projectId: 'p',
      owner: 'example',
      repo: 'demo',
      repositoryId: 1,
      credentialId: 'synthetic',
    }),
    local = store.sources.authorize({
      projectId: 'p',
      path: join(dir, 'synthetic.jsonl'),
    }),
    other = store.sources.authorize({
      projectId: 'q',
      path: join(dir, 'other.jsonl'),
    })
  const create = (id: string, url = issue) => {
    store.tasks.create(
      {
        id,
        projectId: 'p',
        title: '提交修复并反馈链接',
        admission: 'accepted',
      },
      by,
    )
    return store.delivery.start({ ...expected(id), targetUrl: url })
  }
  const add = (
    text: string,
    role: SourceEvent['role'] = 'user',
    externalId = 'local-' + Date.now(),
    source = local.id,
    revision = '1',
  ) => {
    const a = store.sources.getAuthorized(source)
    store.sources.receiveBatch(
      source,
      a.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: source,
          externalId,
          revision,
          role,
          text,
          occurredAt: '2026-09-14T10:00:00Z',
        },
      ],
      externalId + revision,
      a.cursor,
    )
    process()
    return (
      db
        .prepare(
          'SELECT id FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
        )
        .get(source, externalId, revision) as { id: number }
    ).id
  }
  const addPr = (revision = '1', state = 'open', body = issue, number = 2) => {
    const a = store.github.getAuthorized(g.id),
      time = `2026-09-14T${String(10 + Number(revision)).padStart(2, '0')}:00:00Z`
    store.github.receiveBatch({
      id: g.id,
      expectedGrantVersion: a.grantVersion,
      expectedPollVersion: a.pollVersion,
      expectedCursor: a.cursor,
      events: [
        {
          schemaVersion: 1,
          sourceInstanceId: g.id,
          externalId: `pr:${number}`,
          revision,
          role: 'tool',
          occurredAt: time,
          text: JSON.stringify({
            kind: 'github-pull-request',
            repository: 'example/demo',
            repositoryId: 1,
            number,
            url: root + '/pull/' + number,
            state,
            title: '修复',
            body,
            draft: false,
            updatedAt: time,
            mergedAt: state === 'merged' ? time : null,
            base: {
              repository: 'example/demo',
              ref: 'main',
              sha: 'a'.repeat(40),
            },
            head: {
              repository: 'example/demo',
              ref: 'fix',
              sha: 'b'.repeat(40),
              label: 'example:fix',
            },
          }),
        },
      ],
      nextCursor: revision + number,
      nextPollAt: 0,
    })
    process()
    return (
      db
        .prepare(
          'SELECT id FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
        )
        .get(g.id, `pr:${number}`, revision) as { id: number }
    ).id
  }
  assert.equal(create('task').conditions.filter((c) => c.met).length, 0)
  add(`已经完成 ${issue}`, 'assistant', 'assistant')
  assert.equal(
    view().conditions.some((c) => c.met),
    false,
    'assistant never proves delivery',
  )
  add(`已反馈 ${pull}`, 'user', 'foreign', other.id)
  assert.equal(
    view().evidence.some((e) => e.externalId === 'foreign'),
    false,
    'project isolation',
  )
  const feedback = add(`已反馈 ${pull}`, 'user', 'feedback')
  assert.equal(view().canComplete, false)
  const pr = addPr()
  assert.equal(view().conditions[0]!.met, true)
  assert.equal(view().conditions[1]!.met, false, 'PR is only half the delivery')
  assert.equal(
    view().evidence.find((e) => e.eventId === feedback)?.state,
    'pending',
    'out of order backfill',
  )
  resolve(feedback)
  assert.equal(view().canComplete, true)
  assert.equal(
    store.tasks.get('p', 'task')!.status,
    'todo',
    'never automatically complete',
  )
  assert.equal(
    store.tasks
      .listPage({ projectId: 'p', sourceInstanceId: g.id })
      .items.some((t) => t.id === 'task'),
    true,
  )
  const snapshot = view(),
    count = snapshot.history.length
  store.delivery.observe('p', pr)
  assert.equal(view().history.length, count, 'idempotent replay')
  const changed = add(`取消这次提交 ${issue}`, 'user', 'cancel-proposal')
  assert.equal(view().canComplete, false, 'changed agreement requires review')
  assert.throws(
    () =>
      store.delivery.complete({
        ...expected('task'),
        expectedDigest: snapshot.digest,
      }),
    /VERSION_CONFLICT/,
  )
  resolve(changed, 'task', 'confirm')
  assert.equal(
    view().canComplete,
    false,
    'confirming association does not dismiss contradictory agreement',
  )
  resolve(changed, 'task', 'reject')
  assert.equal(view().canComplete, true)
  store.delivery.complete({
    ...expected('task'),
    expectedDigest: view().digest,
  })
  assert.equal(store.tasks.get('p', 'task')!.status, 'completed')
  assert.equal(view().canComplete, false)
  // Two otherwise identical targets never get an arbitrary winner.
  create('a', root + '/issues/3')
  create('b', root + '/issues/3')
  const shared = addPr('1', 'open', root + '/issues/3', 4)
  assert.equal(view('a').evidence[0]?.state, 'pending')
  assert.equal(view('b').evidence[0]?.state, 'pending')
  resolve(shared, 'a')
  assert.equal(view('a').conditions[0]?.met, true)
  assert.equal(view('b').conditions[0]?.met, false)
  const newer = addPr('2', 'open', root + '/issues/3', 4)
  assert.equal(
    view('a').evidence.find((e) => e.eventId === newer)?.state,
    'linked',
    'reuse explicit object ownership',
  )
  assert.equal(
    view('b').evidence.find((e) => e.eventId === newer)?.state,
    'rejected',
  )
  assert.equal(
    view('a').evidence.find((e) => e.eventId === shared)?.state,
    'unavailable',
    'old revision invalid',
  )
  addPr('3', 'closed', root + '/issues/3', 4)
  assert.equal(
    view('a').conditions[0]?.met,
    false,
    'closed unmerged PR is not accepted',
  )
  assert.match(view('a').evidence[0]!.reason, /已关闭/)
  // Criteria changes invalidate the old condition assessment.
  const t = store.tasks.get('p', 'a')!
  store.tasks.replaceCriteria(
    {
      projectId: 'p',
      taskId: 'a',
      expectedVersion: t.version,
      expectedCriteriaVersion: t.criteriaVersion,
      expectedManualVersion: t.manualVersion,
    },
    [{ id: 'new', description: '新约定' }],
    by,
  )
  assert.equal(view('a').stale, true)
  const b = store.tasks.get('p', 'b')!
  store.tasks.update(
    {
      projectId: 'p',
      taskId: 'b',
      expectedVersion: b.version,
      expectedCriteriaVersion: b.criteriaVersion,
      expectedManualVersion: b.manualVersion,
    },
    { status: 'cancelled' },
    by,
  )
  assert.equal(view('b').canComplete, false)
  assert.throws(() => resolve(shared, 'b'), /DELIVERY_READONLY/)
  // Revised feedback is conservative even after a prior manual confirmation.
  add(`尚未反馈 ${pull}`, 'user', 'feedback', local.id, '2')
  assert.equal(view().conditions[1]!.met, false)

  // Real Feishu envelope: only the same author replying to the original commitment auto-satisfies feedback.
  const f = store.feishu.authorize({
    projectId: 'p',
    chatId: 'oc_synthetic_delivery',
    credentialId: '00000000-0000-4000-8000-000000000001',
    startTime: Date.parse('2026-09-14T00:00:00Z'),
    endTime: Date.parse('2026-09-15T00:00:00Z'),
  })
  const chat = (
    externalId: string,
    text: string,
    subject = 'owner',
    reply?: string,
  ) => {
    const a = store.feishu.getAuthorized(f.id)
    store.feishu.receiveBatch({
      id: f.id,
      expectedGrantVersion: a.grantVersion,
      expectedPollVersion: a.pollVersion,
      expectedPageToken: a.pageToken,
      expectedWindowStart: a.windowStart,
      expectedWindowEnd: a.windowEnd,
      events: [
        {
          schemaVersion: 1,
          sourceInstanceId: f.id,
          externalId,
          revision: '1',
          role: 'user',
          occurredAt: '2026-09-14T10:00:00Z',
          text,
          metadata: {
            author: { namespace: 'feishu-open-id', subjectId: subject },
            ...(reply ? { replyToExternalId: reply } : {}),
          },
        },
      ],
      nextPageToken: externalId,
      nextPollAt: 0,
    })
    return (
      db
        .prepare(
          'SELECT id FROM source_events WHERE source_id=? AND external_id=?',
        )
        .get(f.id, externalId) as { id: number }
    ).id
  }
  const baseline = chat('promise', `修复并反馈 ${root}/issues/7`)
  store.tasks.create(
    {
      id: 'chat',
      projectId: 'p',
      title: '真实会话交付',
      admission: 'accepted',
    },
    by,
  )
  store.sourceAssociations.bindSourceObject(
    { ...expected('chat'), eventId: baseline, reason: '确认原约定' },
    'synthetic',
  )
  store.delivery.start({ ...expected('chat'), targetUrl: root + '/issues/7' })
  addPr('1', 'open', root + '/issues/7', 8)
  const wrong = chat('wrong', `已反馈 ${root}/pull/8`, 'other', 'promise')
  process()
  assert.equal(
    view('chat').conditions[1]!.met,
    false,
    'different author requires manual review',
  )
  resolve(wrong, 'chat', 'reject')
  const correct = chat('correct', `已反馈 ${root}/pull/8`, 'owner', 'promise')
  process()
  assert.equal(
    view('chat').evidence.find((e) => e.eventId === correct)?.state,
    'linked',
  )
  assert.equal(
    view('chat').canComplete,
    true,
    'same author and direct original reply',
  )
  store.feishu.revoke(f.id)
  assert.equal(
    view('chat').conditions[1]!.met,
    false,
    'revoked source invalidates feedback',
  )
  const beforeRestart = view()
  store.close()
  store = openStore(path)
  assert.deepEqual(view(), beforeRestart)
  assert.equal(db.pragma('user_version', { simple: true }), 22)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  console.log(
    'delivery integration passed: cross-source, isolation, ambiguity, revisions, cancellation, manual completion, restart',
  )
} finally {
  store.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

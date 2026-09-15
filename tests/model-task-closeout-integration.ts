import { openStore, type StoredTask } from '@memo/storage'
import { TASK_ANALYSIS_PROTOCOL } from '@memo/contracts'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

const root = mkdtempSync(join(tmpdir(), 'bugu-closeout-'))
const path = join(root, 'test.sqlite')
let store = openStore(path)
const actor = { actorId: 'synthetic-user', reason: '明确整理重复任务' }
const expected = (t: StoredTask) => ({
  projectId: t.projectId!,
  taskId: t.id,
  expectedVersion: t.version,
  expectedCriteriaVersion: t.criteriaVersion,
  expectedManualVersion: t.manualVersion,
})
const receive = (id: string, externalId: string, text: string) => {
  const grant = store.sources.getAuthorized(id)
  store.sources.receiveBatch(
    id,
    grant.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: id,
        externalId,
        revision: '1',
        role: 'user',
        text,
        occurredAt: '2026-09-14T23:30:00+08:00',
      },
    ],
    externalId,
    grant.cursor,
  )
}
try {
  store.tasks.createProject('p', '合成模型任务')
  store.tasks.createProject('foreign', '隔离项目')
  const grants = ['one', 'two', 'three'].map((name) =>
    store.sources.authorize({
      projectId: 'p',
      path: join(root, `${name}.jsonl`),
    }),
  )
  const ids: string[] = []
  let firstEnd = 0
  for (const [i, grant] of grants.entries()) {
    const text =
      i === 0 ? '请明天下午5点前提交报告。' : `请补充第${i}份报告。`
    receive(grant.id, 'm1', text)
    const context = store.taskAnalysis.context(grant.id)
    assert.equal(
      context.messages[0]!.occurredAt,
      '2026-09-14T23:30:00+08:00',
    )
    // Adding source timestamps does not replay already processed historical windows.
    const legacyFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          { projectId: 'p', grantVersion: grant.grantVersion },
          0,
          context.messages.map(({ id, role, text }) => ({
            id,
            role,
            text,
          })),
          [],
        ]),
      )
      .digest('hex')
    assert.equal(context.fingerprint, legacyFingerprint)
    if (i === 0) firstEnd = context.endEventId
    const evidence = [{ messageId: context.messages[0]!.id, quote: text }]
    store.taskAnalysis.discover(
      context,
      {
        tasks: [
          {
            title: `报告${i}`,
            stage: 'requested',
            nextAction: '准备报告',
            evidence,
            deadline:
              i === 0
                ? { dueAt: '2026-09-15T09:00:00Z', ...evidence[0]! }
                : null,
          },
        ],
      },
      'synthetic-transport',
      TASK_ANALYSIS_PROTOCOL,
    )
    const task = store.tasks.listPage({ sourceInstanceId: grant.id })
      .items[0]!
    ids.push(task.id)
    assert.equal(store.tasks.creation('p',task.id)?.kind,'ai')
    assert.equal(task.dueAt, i === 0 ? '2026-09-15T09:00:00.000Z' : null)
    assert.equal(task.admission, 'candidate')
    assert.equal(task.status, 'todo')
    assert.equal(
      store.tasks.listPage({
        projectId: 'foreign',
        sourceInstanceId: grant.id,
      }).totalCount,
      0,
    )
  }
  let target = store.tasks.get('p', ids[1]!)!
  target = store.tasks.update(
    expected(target),
    { title: '手动保留的报告', dueAt: '2026-09-20T09:00:00Z' },
    actor,
  )
  target = store.tasks.merge(
    expected(store.tasks.get('p', ids[0]!)!),
    expected(target),
    actor,
  )
  target = store.tasks.merge(
    expected(target),
    expected(store.tasks.get('p', ids[2]!)!),
    actor,
  )
  target = store.tasks.update(
    expected(target),
    { title: '手动最终标题', dueAt: '2026-09-20T09:00:00Z' },
    actor,
  )
  const verify = () => {
    for (const grant of grants) {
      const page = store.tasks.listPage({
        projectId: 'p',
        sourceInstanceId: grant.id,
      })
      assert.deepEqual(
        page.items.map((t) => t.id),
        [target.id],
      )
    }
    assert.equal(
      store.tasks.listPage({ sourceInstanceId: 'missing' }).totalCount,
      0,
    )
    const suggestion = store.taskAnalysis.forTask('p', target.id)!
    const sources = [suggestion, ...suggestion.related].map(
      (x) => x.sourceId,
    )
    assert.deepEqual(new Set(sources), new Set(grants.map((g) => g.id)))
    assert.equal(store.taskAnalysis.forTask('foreign', target.id), null)
    assert.equal(
      store.taskAnalysis.forTask('p', ids[0]!)!.candidate.title,
      '报告0',
    )
  }
  verify()
  store.close()
  store = openStore(path)
  verify()
  const history = new Database(path)
  history.exec("UPDATE decisions SET created_at='2000-01-01T00:00:00.000Z'; UPDATE model_analyses SET created_at='2000-01-01T00:00:00.000Z'")
  history.close()
  assert.equal(store.tasks.listPage({projectId:'p',updatedSince:'2001-01-01T00:00:00.000Z'}).totalCount,0)
  // The old source now reports progress against the surviving merged task.
  receive(
    grants[0]!.id,
    'm2',
    '报告正在修改，明确改为2026年9月18日17点（UTC+8）前交付。',
  )
  const next = store.taskAnalysis.context(grants[0]!.id, firstEnd)
  assert.equal(next.knownTasks.length, 1)
  assert.equal(next.knownTasks[0]!.id, target.id)
  assert.equal(next.knownTasks[0]!.title, '手动最终标题')
  const evidence = next.messages.map((m) => ({
    messageId: m.id,
    quote: m.text,
  }))
  const last = next.messages.find((m) => m.text.includes('正在修改'))!
  store.taskAnalysis.discover(
    next,
    {
      tasks: [
        {
          title: '报告进展',
          existingTaskId: target.id,
          stage: 'in_progress',
          nextAction: '修改报告',
          evidence,
          deadline: {
            dueAt: '2026-09-18T09:00:00Z',
            messageId: last.id,
            quote: last.text,
          },
        },
      ],
    },
    'synthetic-transport',
    TASK_ANALYSIS_PROTOCOL,
  )
  assert.equal(store.tasks.listPage({ projectId: 'p' }).totalCount, 1)
  assert.equal(store.tasks.listPage({projectId:'p',updatedSince:'2001-01-01T00:00:00.000Z'}).totalCount,1)
  assert.equal(store.tasks.get('p', target.id)!.title, '手动最终标题')
  assert.equal(
    store.tasks.get('p', target.id)!.dueAt,
    '2026-09-20T09:00:00.000Z',
  )
  assert.equal(store.tasks.get('p', target.id)!.status, 'todo')
  assert.equal(
    store.taskAnalysis.forTask('p', target.id)!.candidate.nextAction,
    '修改报告',
  )
  console.log(
    'A02/U01/H03: model deadlines, manual priority, source filters, recursive merge provenance, incremental identity and restart passed',
  )
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}

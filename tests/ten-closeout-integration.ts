import { TASK_ANALYSIS_PROTOCOL } from '@memo/contracts'
import { openStore } from '@memo/storage'
import { buildTaskDraft } from '../apps/desktop/src/core/task-drafts'
import { createTaskChatService } from '../apps/desktop/src/core/task-chat'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(tmpdir(), 'bugu-ten-integration-')),
  store = openStore(join(root, 'db.sqlite'))
try {
  store.tasks.createProject('p', '测试项目')
  store.tasks.createProject('q', '隔离项目')
  const by = { actorId: 'test', reason: 'explicit manual record' }
  store.tasks.create(
    { id: 'one', projectId: 'p', title: '核对预算', admission: 'accepted' },
    by,
  )
  store.tasks.create(
    {
      id: 'foreign',
      projectId: 'q',
      title: '其他项目秘密',
      admission: 'accepted',
    },
    by,
  )
  store.tasks.create(
    {
      id: 'candidate',
      projectId: 'p',
      title: '未确认不外发',
      admission: 'candidate',
    },
    by,
  )
  const draft = buildTaskDraft(store, 'p', 'feedback')
  assert.ok(draft.body.includes('核对预算'))
  assert.ok(draft.body.includes('手动状态：待办'))
  assert.ok(draft.body.includes('暂无 AI 来源依据'))
  assert.ok(!draft.body.includes('其他项目秘密'))
  assert.ok(!draft.body.includes('未确认不外发'))
  assert.equal(draft.references[0]!.taskId, 'one')
  assert.equal(draft.references[0]!.version, 1)
  assert.throws(() => buildTaskDraft(store, 'unknown', 'feedback'), /NOT_FOUND/)
  const empty = buildTaskDraft(
    store,
    'p',
    'daily',
    new Date('2000-01-01T00:00:00Z'),
  )
  assert.equal(empty.references.length, 0)
  let calls = 0
  const chat = createTaskChatService(store, async () => {
    calls++
    throw Error('MODEL_NOT_CONFIGURED')
  })
  const result = chat.handle({
    method: 'chat.draft',
    projectId: 'p',
    kind: 'feedback',
  })
  assert.equal(
    result.runs.at(-1)!.draft!.references[0]!.taskId,
    draft.references[0]!.taskId,
  )
  assert.equal(calls, 0)
  assert.deepEqual(result.runs.at(-1)!.actions, [])
  assert.throws(
    () =>
      chat.handle({
        method: 'chat.confirm',
        projectId: 'p',
        runId: result.runs.at(-1)!.id,
      }),
    /CHAT_NOT_READY/,
  )
  const t = store.tasks.get('p', 'one')!
  store.tasks.update(
    {
      projectId: 'p',
      taskId: t.id,
      expectedVersion: t.version,
      expectedCriteriaVersion: t.criteriaVersion,
      expectedManualVersion: t.manualVersion,
    },
    { status: 'completed' },
    by,
  )
  assert.ok(
    buildTaskDraft(store, 'p', 'daily').body.includes('手动状态：已完成'),
  )
  assert.ok(draft.body.includes('手动状态：待办')) // historical snapshot remains unchanged
  const grant = store.sources.authorize({
    projectId: 'p',
    path: join(root, 'synthetic.jsonl'),
  })
  const messages = [
    { role: 'user' as const, text: '请提交月度反馈。' },
    { role: 'assistant' as const, text: '月度反馈已交付，请验收。' },
  ]
  store.sources.receiveBatch(
    grant.id,
    grant.grantVersion,
    messages.map((m, i) => ({
      schemaVersion: 1 as const,
      sourceInstanceId: grant.id,
      externalId: String(i),
      revision: '1',
      occurredAt: '2026-09-15T00:00:00Z',
      ...m,
    })),
    'page',
    '',
  )
  const context = store.taskAnalysis.context(grant.id)
  store.taskAnalysis.discover(
    context,
    {
      tasks: [
        {
          title: '月度反馈',
          stage: 'delivered',
          changeKind: 'feedback',
          nextAction: '等待用户验收',
          evidence: context.messages.map((m) => ({
            messageId: m.id,
            quote: m.text,
          })),
        },
      ],
    },
    'fixture',
    TASK_ANALYSIS_PROTOCOL,
  )
  const ai = store.tasks.listPage({
    projectId: 'p',
    sourceInstanceId: grant.id,
  }).items[0]!
  store.tasks.update(
    {
      projectId: 'p',
      taskId: ai.id,
      expectedVersion: ai.version,
      expectedCriteriaVersion: ai.criteriaVersion,
      expectedManualVersion: ai.manualVersion,
    },
    { admission: 'accepted' },
    by,
  )
  const grounded = buildTaskDraft(store, 'p', 'feedback')
  assert.ok(
    grounded.references.some(
      (r) => r.taskId === ai.id && r.quote === '月度反馈已交付，请验收。',
    ),
  )
  assert.ok(grounded.body.includes('AI 下一步建议（待复核）：等待用户验收'))
  assert.equal(store.tasks.get('p', ai.id)!.status, 'todo')
  for (let i = 0; i < 21; i++)
    store.tasks.create(
      {
        id: 'task-' + i,
        projectId: 'p',
        title: '分页事项 ' + i,
        admission: 'accepted',
      },
      by,
    )
  const limited = buildTaskDraft(store, 'p', 'feedback')
  assert.equal(limited.truncated, true)
  assert.ok(limited.body.includes('仅包含前 20 项'))
  chat.dispose()
  console.log(
    'draft scope, references, manual operation with model disabled, snapshots and pagination: passed',
  )
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}

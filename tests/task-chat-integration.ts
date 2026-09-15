import { openStore } from '@memo/storage'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { ChatAction } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-chat-test-'))
const path = join(dir, 'db.sqlite')
let store = openStore(path)
const action = (
  kind: ChatAction['kind'],
  taskId = '',
  title: string | null = null,
): ChatAction => ({
  kind,
  taskId,
  title,
  status: null,
  dueAt: null,
  owner: null,
})
function proposal(actions: ChatAction[]) {
  const r = store.taskChat.start('a', '虚构用户请求')
  store.taskChat.finish(
    r.id,
    'a',
    {
      message: '请确认',
      tool: 'propose_changes',
      query: '',
      taskId: '',
      actions,
    },
    store.taskChat.search('a', '').items,
    'fixture',
  )
  return r.id
}
try {
  store.tasks.createProject('a', '测试项目')
  store.tasks.createProject('b', '隔离项目')
  const create = proposal([action('create', '', '准备路演')])
  store.taskChat.confirm(create, 'a')
  store.taskChat.confirm(create, 'a')
  assert.equal(store.tasks.list('a').length, 1)
  const task = store.tasks.list('a')[0]!
  const creation = store.tasks.creation('a', task.id)
  assert.equal(creation?.kind, 'chat')
  assert.ok(creation?.createdAt)
  assert.throws(() => store.taskChat.read(create, 'b'), /NOT_FOUND/)
  const stale = proposal([action('update', task.id, '改标题')])
  store.tasks.update(
    {
      projectId: 'a',
      taskId: task.id,
      expectedVersion: task.version,
      expectedCriteriaVersion: task.criteriaVersion,
      expectedManualVersion: task.manualVersion,
    },
    { title: '人工修改优先' },
    { actorId: 'test', reason: '人工修改' },
  )
  assert.throws(() => store.taskChat.confirm(stale, 'a'), /VERSION_CONFLICT/)
  const rollback = proposal([
    action('create', '', '应回滚'),
    action('restore', task.id),
  ])
  assert.throws(() => store.taskChat.confirm(rollback, 'a'), /CHAT_NOT_DELETED/)
  assert.equal(store.tasks.list('a').length, 1)
  const remove = proposal([action('delete', task.id)])
  store.taskChat.confirm(remove, 'a')
  assert.equal(
    store.tasks.listPage({ projectId: 'a', archive: 'all' }).items.length,
    0,
  )
  assert.equal(store.taskChat.get('a', task.id).deleted, true)
  const restore = proposal([action('restore', task.id)])
  store.taskChat.confirm(restore, 'a')
  assert.equal(store.tasks.listPage({ projectId: 'a' }).items.length, 1)
  assert.equal(store.taskChat.get('a', task.id).title, '人工修改优先')
  assert.deepEqual(store.tasks.creation('a', task.id), creation)
  const unknown = store.taskChat.start('a', '虚构')
  assert.throws(
    () =>
      store.taskChat.finish(
        unknown.id,
        'a',
        {
          message: 'bad',
          tool: 'propose_changes',
          query: '',
          taskId: '',
          actions: [action('delete', 'other')],
        },
        [],
        'fixture',
      ),
    /CHAT_UNKNOWN_TASK/,
  )
  const pending = store.taskChat.start('a', '重启中断')
  store.close()
  store = openStore(path)
  store.taskChat.recover()
  assert.equal(store.taskChat.read(pending.id, 'a').state, 'failed')
  assert.equal(store.taskChat.read(create, 'a').state, 'applied')
  console.log(
    'Task chat storage: CRUD, trash restore, idempotency, project isolation, stale version, atomic rollback and restart passed',
  )
} finally {
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

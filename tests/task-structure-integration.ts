import { openStore, type StoredTask, type TaskExpectation } from '@memo/storage'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const folder = mkdtempSync(join(tmpdir(), 'bugu-task-structure-'))
const path = join(folder, 'structure.sqlite')
const by = { actorId: 'synthetic-user', reason: '用户整理混杂事项' }
const expected = (task: StoredTask): TaskExpectation => ({
  projectId: task.projectId!,
  taskId: task.id,
  expectedVersion: task.version,
  expectedCriteriaVersion: task.criteriaVersion,
  expectedManualVersion: task.manualVersion,
})
try {
  const store = openStore(path)
  const tasks = store.tasks
  assert.equal(store.health().schemaVersion, 22)
  store.registerSource('fixture')
  for (let i = 1; i <= 3; i++)
    store.receive(
      {
        schemaVersion: 1,
        sourceInstanceId: 'fixture',
        externalId: `e${i}`,
        revision: '1',
        occurredAt: '2026-09-14T00:00:00Z',
        role: 'user',
        text: `虚构记录 ${i}`,
      },
      `cursor-${i}`,
    )
  tasks.createProject('alpha', '拆分项目')
  tasks.assignEvent('alpha', 1)
  tasks.assignEvent('alpha', 2)
  tasks.assignEvent('alpha', 3)
  // H04 前置：直接构造双条件事项（合并路径由 #124 自己的测试覆盖）。
  let parent = tasks.create(
    { id: 'keep', projectId: 'alpha', title: '保留事项', admission: 'accepted' },
    by,
  )
  parent = tasks.replaceCriteria(
    expected(parent),
    [
      { id: 'c1', description: '反馈链接', originEventId: 1 },
      { id: 'c2', description: '补充测试', originEventId: 2 },
    ],
    by,
  )
  parent = tasks.addEvidence(
    expected(parent),
    {
      id: 'ev-keep-1',
      criterionId: 'c1',
      criteriaVersion: parent.criteriaVersion,
      eventId: 1,
      relation: 'supports',
      validity: 'valid',
      reason: '手工核验',
    },
    by,
  )
  parent = tasks.addEvidence(
    expected(parent),
    {
      id: 'ev-keep-2',
      criterionId: 'c2',
      criteriaVersion: parent.criteriaVersion,
      eventId: 2,
      relation: 'supports',
      validity: 'valid',
      reason: '第二条件的证据',
    },
    by,
  )
  // 拆分：c2 → 新事项；c1 与证据留在原事项。
  const before = tasks.get('alpha', parent.id)!
  const splitOutcome = tasks.split(
    {
      ...expected(before),
      children: [{ title: '拆出的补充测试', criterionIds: ['c2'] }],
    },
    by,
  )
  assert.equal(splitOutcome.children.length, 1)
  const child = splitOutcome.children[0]!
  assert.equal(child.projectId, 'alpha')
  assert.equal(child.admission, before.admission)
  assert.deepEqual(
    tasks.getCriteria('alpha', child.id).items.map((x) => x.id),
    ['c2'],
  )
  assert.deepEqual(
    (tasks.history('alpha', child.id).evidence as {
      criterion_version: number
      criterion_id: string
    }[]).filter((l) => l.criterion_version === 1).map((l) => l.criterion_id),
    ['c2'],
  )
  assert.deepEqual(
    tasks.getCriteria('alpha', parent.id).items.map((x) => x.id),
    ['c1'],
  )
  assert.deepEqual(
    (tasks.history('alpha', parent.id).evidence as {
      criterion_version: number
      criterion_id: string
    }[])
      .filter((l) => l.criterion_version === before.criteriaVersion + 1)
      .map((l) => l.criterion_id),
    ['c1'],
  )
  // 双向拆分记录。
  assert.equal(tasks.splitChildren('alpha', parent.id)[0]?.taskId, child.id)
  assert.equal(tasks.splitParent('alpha', child.id)?.taskId, parent.id)
  // 拒绝：未知条件 / 跨子项重复 / 过时版本 / 归档事项。
  const after = tasks.get('alpha', parent.id)!
  assert.throws(
    () =>
      tasks.split(
        {
          ...expected(after),
          children: [{ title: '不存在条件', criterionIds: ['missing'] }],
        },
        by,
      ),
    /INVALID_TASK_SPLIT/,
  )
  assert.throws(
    () =>
      tasks.split(
        {
          ...expected(after),
          children: [
            { title: 'A', criterionIds: ['c1'] },
            { title: 'B', criterionIds: ['c1'] },
          ],
        },
        by,
      ),
    /INVALID_TASK_SPLIT/,
  )
  assert.throws(
    () =>
      tasks.split(
        {
          ...expected(after),
          expectedVersion: after.version + 1,
          children: [{ title: '过时', criterionIds: ['c1'] }],
        },
        by,
      ),
    /VERSION_CONFLICT/,
  )
  // 数据库级完整性：无悬挂外键，拆分表结构就位。
  const raw = new Database(path)
  raw.pragma('foreign_keys=ON')
  assert.equal(
    (
      raw.prepare('SELECT count(*) AS n FROM pragma_foreign_key_check').get() as {
        n: number
      }
    ).n,
    0,
  )
  assert.equal(
    (
      raw.prepare('SELECT count(*) AS n FROM task_splits').get() as { n: number }
    ).n,
    1,
  )
  raw.close()
  store.close()
  const reopened = openStore(path)
  assert.equal(reopened.health().schemaVersion, 22)
  assert.equal(
    reopened.tasks.splitParent('alpha', child.id)?.taskId,
    parent.id,
  )
  reopened.close()
  console.log(
    'Task structure integration passed: split links + evidence ownership + conflicts + FK integrity（合并部分由 #124 覆盖）',
  )
} finally {
  // Windows 往往短暂锁住刚关闭的 WAL 文件；清理失败不能掩盖真实断言结果。
  try {
    rmSync(folder, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  } catch {
    /* 留给系统临时目录回收 */
  }
}

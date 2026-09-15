/** Only synthetic records in a temporary profile; never a production startup seed. */
import { openStore } from '@memo/storage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]!
mkdirSync(root, { recursive: true })
const store = openStore(join(root, 'memo.sqlite'))
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('review', '产品迭代')
  const grant = store.sources.authorize({
    projectId: 'review',
    path: join(root, '产品讨论.jsonl'),
  })
  const text =
    '请补充登录过期的回归测试，覆盖重新登录和刷新页面。修改已提交，等测试通过后反馈结果。'
  store.sources.receiveBatch(
    grant.id,
    grant.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: grant.id,
        externalId: 'fixture-message',
        revision: '1',
        occurredAt: new Date().toISOString(),
        role: 'user',
        text,
      },
    ],
    '1',
    '',
  )
  store.taskAnalysis.discover(
    store.taskAnalysis.context(grant.id),
    {
      tasks: [
        {
          title: '补充登录过期的回归测试',
          stage: 'in_progress',
          nextAction: '验证重新登录与页面刷新，再反馈测试结果。',
          evidence: [
            {
              messageId: store.taskAnalysis.context(grant.id).messages[0]!.id,
              quote: text,
            },
          ],
        },
      ],
    },
    'synthetic-model',
    'interface-test',
  )
  store.sources.revoke(grant.id)
  store.tasks.create(
    {
      id: 'manual',
      projectId: 'review',
      title: '整理本周产品反馈',
      admission: 'accepted',
    },
    { actorId: 'synthetic-user', reason: '界面验收记录' },
  )
} finally {
  store.close()
}

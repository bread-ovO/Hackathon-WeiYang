/** Isolated synthetic delivery records; no OS credential reads or network. */
import { openStore } from '@memo/storage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const profile = join(process.argv[2]!, 'profile')
mkdirSync(profile, { recursive: true })
const store = openStore(join(profile, 'memo.sqlite'))
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('demo', '交付演示')
  store.tasks.create(
    {
      id: 'delivery',
      projectId: 'demo',
      title: '提交登录修复，并反馈 PR 链接',
      admission: 'accepted',
    },
    { actorId: 'synthetic', reason: '演示数据' },
  )
  const source = store.sources.authorize({
    projectId: 'demo',
    path: join(profile, 'synthetic.jsonl'),
  })
  store.sources.receiveBatch(
    source.id,
    source.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: source.id,
        externalId: 'feedback',
        revision: '1',
        role: 'user',
        occurredAt: '2026-09-14T10:00:00Z',
        text: '已反馈登录修复 PR，请查收 https://github.com/example/demo/pull/2',
      },
    ],
    '1',
    '',
  )
  const g = store.github.authorize({
      projectId: 'demo',
      owner: 'example',
      repo: 'demo',
      repositoryId: 1,
      credentialId: 'synthetic',
    }),
    a = store.github.getAuthorized(g.id)
  store.github.receiveBatch({
    id: g.id,
    expectedGrantVersion: a.grantVersion,
    expectedPollVersion: a.pollVersion,
    expectedCursor: a.cursor,
    nextCursor: '1',
    nextPollAt: 4102444800000,
    events: [
      {
        schemaVersion: 1,
        sourceInstanceId: g.id,
        externalId: 'pr:2',
        revision: '1',
        role: 'tool',
        occurredAt: '2026-09-14T10:00:00Z',
        text: JSON.stringify({
          kind: 'github-pull-request',
          repository: 'example/demo',
          repositoryId: 1,
          number: 2,
          url: 'https://github.com/example/demo/pull/2',
          state: 'open',
          body: '修复 https://github.com/example/demo/issues/1',
          title: '登录修复',
          draft: false,
          updatedAt: '2026-09-14T10:00:00Z',
          mergedAt: null,
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
  })
  store.github.setEnabled(g.id, false)
} finally {
  store.close()
}

/** Isolated management-UI fixture; no credentials or network reads. */
import { openStore } from '@memo/storage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const profile = join(process.argv[2]!, 'profile')
mkdirSync(profile, { recursive: true })
const store = openStore(join(profile, 'memo.sqlite'))
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('feishu-fixture', '飞书窗口验收')
  const startTime = Date.parse('2026-09-13T00:00:00Z'),
    endTime = startTime + 120000
  const connection = store.feishu.authorize({
    projectId: 'feishu-fixture',
    chatId: 'oc_synthetic_history',
    credentialId: '00000000-0000-4000-8000-000000000001',
    startTime,
    endTime,
  })
  let grant = store.feishu.getAuthorized(connection.id)
  const event = {
    schemaVersion: 1 as const,
    sourceInstanceId: connection.id,
    externalId: 'om_fixture',
    revision: '1',
    role: 'user' as const,
    occurredAt: '2026-09-13T00:00:00Z',
    text: '虚构历史消息，仅用于管理页面验收。',
  }
  store.feishu.receiveBatch({
    id: connection.id,
    expectedGrantVersion: grant.grantVersion,
    expectedPollVersion: grant.pollVersion,
    expectedPageToken: '',
    expectedWindowStart: grant.windowStart,
    expectedWindowEnd: grant.windowEnd,
    events: [
      event,
      { ...event, revision: '2', operation: 'retract', text: '' },
    ],
    nextPageToken: '',
    nextPollAt: Date.now() + 86400000,
  })
  grant = store.feishu.getAuthorized(connection.id)
  store.feishu.beginWindow({
    id: connection.id,
    expectedGrantVersion: grant.grantVersion,
    expectedPollVersion: grant.pollVersion,
    until: endTime + 60000,
  })
  store.feishu.setEnabled(connection.id, false)
} finally {
  store.close()
}

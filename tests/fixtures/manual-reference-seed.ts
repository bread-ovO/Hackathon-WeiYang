/** Synthetic fixture for reviewing existing manual evidence, not a production creation UI. */
import { openStore, type StoredTask } from '@memo/storage'
import { join } from 'node:path'
import { mkdirSync, realpathSync } from 'node:fs'
const root = process.argv[2]!
const profile = join(root, 'profile')
mkdirSync(profile, { recursive: true })
const store = openStore(join(profile, 'memo.sqlite'))
const actor = { actorId: 'fixture-user', reason: '虚构人工引用初始化' }
const expected = (t: StoredTask) => ({
  projectId: 'manual-project',
  taskId: t.id,
  expectedVersion: t.version,
  expectedCriteriaVersion: t.criteriaVersion,
  expectedManualVersion: t.manualVersion,
})
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('manual-project', '人工引用验收')
  const source = store.sources.authorize({
    projectId: 'manual-project',
    path: realpathSync(join(root, 'fictional.jsonl')),
  })
  store.sources.receiveBatch(
    source.id,
    source.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: source.id,
        externalId: 'manual-message',
        revision: '1',
        role: 'user',
        occurredAt: '2026-09-13T00:00:00Z',
        text: '人工证据原文第一版。',
      },
    ],
    '',
    '',
  )
  const task = store.tasks.create(
    {
      id: 'manual-task',
      projectId: 'manual-project',
      title: '已有人工证据事项',
      admission: 'accepted',
    },
    actor,
  )
  store.tasks.replaceCriteria(
    expected(task),
    [{ id: 'criterion', description: '人工检查交付', originEventId: 1 }],
    actor,
  )
  const current = store.tasks.get('manual-project', task.id)!
  store.tasks.addEvidence(
    expected(current),
    {
      id: 'manual-evidence',
      criterionId: 'criterion',
      criteriaVersion: current.criteriaVersion,
      eventId: 1,
      relation: 'supports',
      validity: 'valid',
      reason: '人工已有引用',
    },
    actor,
  )
} finally {
  store.close()
}

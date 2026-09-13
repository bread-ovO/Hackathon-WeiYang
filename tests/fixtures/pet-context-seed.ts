import { openStore } from '@memo/storage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]!,
  profile = join(root, 'profile')
mkdirSync(profile, { recursive: true })
const store = openStore(join(profile, 'memo.sqlite'))
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('pet-project', '桌宠上下文验收')
  const grant = store.sources.authorize({
    projectId: 'pet-project',
    path: join(root, 'fictional.jsonl'),
  })
  store.sources.receiveBatch(
    grant.id,
    grant.grantVersion,
    [
      {
        schemaVersion: 1,
        sourceInstanceId: grant.id,
        externalId: 'fictional',
        revision: '1',
        role: 'user',
        text: 'PRIVATE_SYNTHETIC_BODY_NEVER_TO_MODEL',
        occurredAt: '2026-09-13T00:00:00Z',
      },
    ],
    '1',
    '',
  )
  const actor = { actorId: 'fixture', reason: '合成有效引用' }
  let task = store.tasks.create(
    {
      id: 'pet-task',
      projectId: 'pet-project',
      title: '桌宠引用事项',
      admission: 'accepted',
    },
    actor,
  )
  const expected = () => ({
    projectId: 'pet-project',
    taskId: task.id,
    expectedVersion: task.version,
    expectedCriteriaVersion: task.criteriaVersion,
    expectedManualVersion: task.manualVersion,
  })
  task = store.tasks.replaceCriteria(
    expected(),
    [{ id: 'criterion', description: '合成确认条件' }],
    actor,
  )
  store.tasks.addEvidence(
    expected(),
    {
      id: 'evidence',
      criterionId: 'criterion',
      criteriaVersion: task.criteriaVersion,
      eventId: 1,
      relation: 'supports',
      validity: 'valid',
      reason: '合成已核验',
    },
    actor,
  )
  store.tasks.create(
    {
      id: 'draft-task',
      projectId: 'pet-project',
      title: '保留草稿的另一事项',
      admission: 'accepted',
    },
    actor,
  )
} finally {
  store.close()
}

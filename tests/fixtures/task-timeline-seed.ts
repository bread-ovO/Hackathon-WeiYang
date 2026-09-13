/** Isolated synthetic manual history, never a production IPC seed path. */
import { openStore } from '@memo/storage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const profile = join(process.argv[2]!, 'profile')
mkdirSync(profile, { recursive: true })
const store = openStore(join(profile, 'memo.sqlite'))
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('timeline-project', '时间线分页验收')
  let task = store.tasks.create(
    {
      id: 'timeline-task',
      projectId: 'timeline-project',
      title: '分页验收事项',
      admission: 'accepted',
    },
    { actorId: 'fixture-actor', reason: '虚构初始化' },
  )
  for (let i = 1; i <= 45; i++) {
    task = store.tasks.update(
      {
        projectId: 'timeline-project',
        taskId: task.id,
        expectedVersion: task.version,
        expectedCriteriaVersion: task.criteriaVersion,
        expectedManualVersion: task.manualVersion,
      },
      { title: `分页验收事项 ${i}` },
      { actorId: 'fixture-actor', reason: `虚构调整 ${i}` },
    )
  }
} finally {
  store.close()
}

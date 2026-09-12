import { randomUUID } from 'node:crypto'
import type { openStore } from '@memo/storage'
import type {
  WorkspaceRequest,
  WorkspaceSnapshot,
  WorkspaceDetail,
} from '@memo/contracts'
export function handleWorkspace(
  store: ReturnType<typeof openStore>,
  request: WorkspaceRequest,
): WorkspaceSnapshot | WorkspaceDetail {
  const by = { actorId: 'local-user', reason: '用户在我的工作区手动操作' }
  switch (request.method) {
    case 'workspace.detail': {
      const task = store.tasks.get(request.projectId, request.id)
      if (!task) throw new Error('TASK_NOT_IN_PROJECT')
      return {
        task,
        provenance: store.processing.getTaskEvidence(request.projectId, request.id),
        criteria: store.tasks.getCriteria(
          request.projectId,
          request.id,
          request.criteriaVersion,
        ),
      }
    }
    case 'workspace.createProject':
      store.tasks.createProject(randomUUID(), request.name)
      break
    case 'workspace.createTask':
      store.tasks.create(
        {
          id: randomUUID(),
          projectId: request.projectId,
          title: request.title,
          admission: 'accepted',
        },
        by,
      )
      break
    case 'workspace.updateTask':
      store.tasks.update(
        {
          projectId: request.projectId,
          taskId: request.id,
          expectedVersion: request.expectedVersion,
          expectedCriteriaVersion: request.expectedCriteriaVersion,
          expectedManualVersion: request.expectedManualVersion,
        },
        request.patch,
        by,
      )
      break
    case 'workspace.replaceCriteria':
      store.tasks.replaceCriteria(
        {
          projectId: request.projectId,
          taskId: request.id,
          expectedVersion: request.expectedVersion,
          expectedCriteriaVersion: request.expectedCriteriaVersion,
          expectedManualVersion: request.expectedManualVersion,
        },
        request.criteria,
        by,
      )
      break
  }
  const page = store.tasks.listPage(
    request.method === 'workspace.list' ? request.query : undefined,
  )
  return {
    projects: store.tasks.listProjects(),
    tasks: page.items,
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
    activeCount: page.activeCount,
  }
}

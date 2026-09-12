import { randomUUID } from 'node:crypto'
import type { openStore } from '@memo/storage'
import type { WorkspaceRequest, WorkspaceSnapshot } from '@memo/contracts'
export function handleWorkspace(
  store: ReturnType<typeof openStore>,
  request: WorkspaceRequest,
): WorkspaceSnapshot {
  const by = { actorId: 'local-user', reason: '用户在我的工作区手动操作' }
  switch (request.method) {
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
  }
  const projects = store.tasks.listProjects()
  return {
    projects,
    tasks: [
      ...projects.flatMap((p) => store.tasks.list(p.id)),
      ...store.tasks.listUnassigned(),
    ],
  }
}

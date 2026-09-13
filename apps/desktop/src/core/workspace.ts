import { randomUUID } from 'node:crypto'
import type { openStore } from '@memo/storage'
import type {
  WorkspaceRequest,
  WorkspaceSnapshot,
  WorkspaceDetail,
  ReferenceList,
  ReferenceReview,
  TimelinePage,
  PlanChangesPage,
  PlanChangeResult,
  PlanChangeProposal,
  ProjectSourceEvents,
  SourceBindings,
  IdentityMappings,
} from '@memo/contracts'
export function handleWorkspace(
  store: ReturnType<typeof openStore>,
  request: WorkspaceRequest,
):
  | WorkspaceSnapshot
  | WorkspaceDetail
  | ReferenceList
  | ReferenceReview
  | TimelinePage
  | PlanChangesPage
  | PlanChangeResult
  | PlanChangeProposal
  | ProjectSourceEvents
  | SourceBindings
  | IdentityMappings {
  const by = { actorId: 'local-user', reason: '用户在我的工作区手动操作' }
  switch (request.method) {
    case 'workspace.sourceEvents': {
      const { method: _, ...input } = request
      return store.sourceAssociations.sourceEvents(input)
    }
    case 'workspace.sourceBindings': {
      const { method: _, ...input } = request
      return store.sourceAssociations.sourceBindings(input)
    }
    case 'workspace.bindSourceObject': {
      const { method: _, ...input } = request
      return store.sourceAssociations.bindSourceObject(input, 'local-user')
    }
    case 'workspace.revokeSourceBinding': {
      const { method: _, ...input } = request
      return store.sourceAssociations.revokeSourceBinding(input, 'local-user')
    }
    case 'workspace.identityMappings': {
      const { method: _, ...input } = request
      return store.sourceAssociations.identityMappings(input)
    }
    case 'workspace.confirmIdentityMapping': {
      const { method: _, ...input } = request
      return store.sourceAssociations.confirmIdentityMapping(
        input,
        'local-user',
      )
    }
    case 'workspace.revokeIdentityMapping': {
      const { method: _, ...input } = request
      return store.sourceAssociations.revokeIdentityMapping(input, 'local-user')
    }

    case 'workspace.reevaluatePlanChange': {
      const { method: _, ...input } = request
      return store.planChanges.reevaluate(input, 'local-user')
    }
    case 'workspace.planChanges': {
      const { method: _, ...input } = request
      return store.planChanges.list(input)
    }
    case 'workspace.confirmPlanChange': {
      const { method: _, ...input } = request
      return { task: store.planChanges.confirm(input, 'local-user') }
    }
    case 'workspace.timeline': {
      const { method: _, ...input } = request
      return store.timeline.list(input)
    }
    case 'workspace.listReferences': {
      const { method: _, ...input } = request
      return store.revisionReview.listReferences(input)
    }
    case 'workspace.reviewReference': {
      const { method: _, ...input } = request
      return store.revisionReview.reviewReference(input)
    }
    case 'workspace.confirmReference': {
      const { method: _, ...input } = request
      return store.revisionReview.confirmReference(input, 'local-user')
    }
    case 'workspace.detail': {
      const task = store.tasks.get(request.projectId, request.id)
      if (!task) throw new Error('TASK_NOT_IN_PROJECT')
      return {
        task,
        provenance: store.processing.getTaskEvidence(
          request.projectId,
          request.id,
        ),
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

import type { WorkspaceTask } from './workspace'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const version = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
export const planChangeRequestSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectId', 'taskId'],
    properties: {
      method: { const: 'workspace.planChanges' },
      projectId: id,
      taskId: id,
      cursor: { type: 'string', minLength: 1, maxLength: 4096 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'method',
      'projectId',
      'taskId',
      'proposalId',
      'expectedAssessmentVersion',
      'expectedVersion',
      'expectedCriteriaVersion',
      'expectedManualVersion',
      'reason',
    ],
    properties: {
      method: { const: 'workspace.confirmPlanChange' },
      projectId: id,
      taskId: id,
      proposalId: { ...version, minimum: 1 },
      expectedAssessmentVersion: version,
      expectedVersion: { ...version, minimum: 1 },
      expectedCriteriaVersion: version,
      expectedManualVersion: version,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        pattern:
          '^[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$',
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'method',
      'projectId',
      'taskId',
      'eventId',
      'expectedVersion',
      'expectedCriteriaVersion',
      'expectedManualVersion',
      'reason',
    ],
    properties: {
      method: { const: 'workspace.reevaluatePlanChange' },
      projectId: id,
      taskId: id,
      eventId: { ...version, minimum: 1 },
      expectedVersion: { ...version, minimum: 1 },
      expectedCriteriaVersion: version,
      expectedManualVersion: version,
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        pattern:
          '^[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$',
      },
    },
  },
] as const
export interface PlanChangeProposal {
  id: number
  assessmentVersion: number
  taskId: string
  dueAt: string
  quote: string
  eventId: number
  sourceInstanceId: string
  externalId: string
  revision: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  occurredAt: string
  receivedAt: string
  createdAt: string
  status: 'pending' | 'applied'
  guard:
    | 'ready'
    | 'late_occurrence'
    | 'unknown_revision_order'
    | 'reference_invalidated'
    | 'identity_unknown'
    | 'identity_mismatch'
    | 'simultaneous_conflict'
    | 'source_unavailable'
    | 'retracted'
    | 'task_changed'
    | 'association_changed'
    | 'mapping_changed'
  sourceStatus: 'active' | 'paused' | 'revoked' | 'uninstalled' | 'unknown'
  taskVersion: number
  criteriaVersion: number
  manualVersion: number
  appliedAt: string | null
}
export interface PlanChangesPage {
  proposals: PlanChangeProposal[]
  nextCursor: string | null
}
export interface PlanChangeResult {
  task: WorkspaceTask
}

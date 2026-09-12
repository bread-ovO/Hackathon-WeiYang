import type { FromSchema } from 'json-schema-to-ts'
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
const status = {
  enum: ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'],
} as const
const admission = { enum: ['candidate', 'accepted', 'ignored'] } as const
const dueAt = {
  anyOf: [
    { type: 'string', maxLength: 24, format: 'workspace-date-time' },
    { type: 'null' },
  ],
} as const
const expectation = {
  id,
  projectId: id,
  expectedVersion: { ...version, minimum: 1 },
  expectedCriteriaVersion: version,
  expectedManualVersion: version,
} as const
const expected = [
  'projectId',
  'id',
  'expectedVersion',
  'expectedCriteriaVersion',
  'expectedManualVersion',
] as const
export const workspaceQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectId: { anyOf: [id, { type: 'null' }] },
    status,
    admission,
    archive: { enum: ['active', 'archived', 'all'] },
    query: { type: 'string', maxLength: 256 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, maxLength: 4096 },
  },
} as const
export type WorkspaceQuery = FromSchema<typeof workspaceQuerySchema>
export const workspaceRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: {
        method: { const: 'workspace.list' },
        query: workspaceQuerySchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'id'],
      properties: {
        method: { const: 'workspace.detail' },
        projectId: id,
        id,
        criteriaVersion: version,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'name'],
      properties: {
        method: { const: 'workspace.createProject' },
        name: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'title'],
      properties: {
        method: { const: 'workspace.createTask' },
        projectId: id,
        title: { type: 'string', minLength: 1, maxLength: 512 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', ...expected, 'patch'],
      properties: {
        method: { const: 'workspace.updateTask' },
        ...expectation,
        patch: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 512 },
            status,
            admission,
            dueAt,
            archived: { type: 'boolean' },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', ...expected, 'criteria'],
      properties: {
        method: { const: 'workspace.replaceCriteria' },
        ...expectation,
        criteria: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'description'],
            properties: {
              id,
              description: { type: 'string', minLength: 1, maxLength: 512 },
              originEventId: { ...version, minimum: 1 },
            },
          },
        },
      },
    },
  ],
} as const
export type WorkspaceRequest = FromSchema<typeof workspaceRequestSchema>
export interface WorkspaceTask {
  id: string
  projectId: string | null
  title: string
  status: 'todo' | 'in_progress' | 'waiting' | 'completed' | 'cancelled'
  evidenceStatus: 'unknown' | 'partial' | 'sufficient' | 'conflict'
  admission: 'candidate' | 'accepted' | 'ignored'
  version: number
  criteriaVersion: number
  manualVersion: number
  archivedAt: string | null
  dueAt: string | null
}
export interface WorkspaceSnapshot {
  projects: { id: string; name: string }[]
  tasks: WorkspaceTask[]
  nextCursor: string | null
  totalCount: number
  activeCount: number
}
export interface CandidateProvenance {
  eventStatus: 'present' | 'retracted'
  referenceStatus: 'available' | 'invalidated'
  retraction: null | {
    eventId: number
    occurredAt: string
    receivedAt: string
    reasonCode: 'explicit_source_retraction'
  }
  quoteKind: 'exact' | 'revision_excerpt'
  policyVersion: string
  actor: 'rule'
  outcome: 'created' | 'review_required'
  sourceStatus: 'active' | 'revoked' | 'uninstalled' | 'unknown'
  revisionStatus: 'current' | 'review_required'
  eventId: number
  sourceInstanceId: string
  externalId: string
  revision: string
  quoteStart: number
  quoteEnd: number
  quote: string
  reason: string
  createdAt: string
}
export interface WorkspaceDetail {
  provenance?: CandidateProvenance[]
  task: WorkspaceTask
  criteria: {
    version: number
    items: { id: string; description: string; originEventId?: number }[]
  }
}

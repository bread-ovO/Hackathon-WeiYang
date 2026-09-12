import type { FromSchema } from 'json-schema-to-ts'
const id = { type: 'string', minLength: 1, maxLength: 256 } as const
export const workspaceRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'workspace.list' } },
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
      required: [
        'method',
        'projectId',
        'id',
        'expectedVersion',
        'expectedCriteriaVersion',
        'expectedManualVersion',
        'patch',
      ],
      properties: {
        method: { const: 'workspace.updateTask' },
        id,
        projectId: id,
        expectedCriteriaVersion: {
          type: 'integer',
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: 0,
        },
        expectedManualVersion: {
          type: 'integer',
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: 0,
        },
        expectedVersion: {
          type: 'integer',
          maximum: Number.MAX_SAFE_INTEGER,
          minimum: 1,
        },
        patch: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 512 },
            status: {
              enum: [
                'todo',
                'in_progress',
                'waiting',
                'completed',
                'cancelled',
              ],
            },
            archived: { type: 'boolean' },
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
  admission: string
  version: number
  criteriaVersion: number
  manualVersion: number
  archivedAt: string | null
}
export interface WorkspaceSnapshot {
  projects: { id: string; name: string }[]
  tasks: WorkspaceTask[]
}

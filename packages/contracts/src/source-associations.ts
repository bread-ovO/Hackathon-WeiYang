const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const version = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
const zero = { ...version, minimum: 0 } as const
const reason = {
  type: 'string',
  minLength: 1,
  maxLength: 512,
  pattern:
    '^[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f][^\\u0000-\\u001f\\u007f]*$',
} as const
const scope = { projectId: id, taskId: id } as const
export const sourceAssociationRequestSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectId'],
    properties: {
      method: { const: 'workspace.sourceEvents' },
      projectId: id,
      sourceInstanceId: id,
      cursor: { type: 'string', minLength: 1, maxLength: 4096 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectId', 'taskId'],
    properties: { method: { const: 'workspace.sourceBindings' }, ...scope },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'method',
      'projectId',
      'taskId',
      'eventId',
      'expectedTaskVersion',
      'expectedCriteriaVersion',
      'expectedManualVersion',
      'reason',
    ],
    properties: {
      method: { const: 'workspace.bindSourceObject' },
      ...scope,
      eventId: version,
      expectedTaskVersion: version,
      expectedCriteriaVersion: zero,
      expectedManualVersion: zero,
      reason,
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'method',
      'projectId',
      'taskId',
      'id',
      'expectedVersion',
      'reason',
    ],
    properties: {
      method: { const: 'workspace.revokeSourceBinding' },
      ...scope,
      id,
      expectedVersion: version,
      reason,
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectId', 'taskId'],
    properties: { method: { const: 'workspace.identityMappings' }, ...scope },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'method',
      'projectId',
      'taskId',
      'leftEventId',
      'rightEventId',
      'expectedLeftBindingVersion',
      'expectedRightBindingVersion',
      'expectedMappingVersion',
      'reason',
    ],
    properties: {
      method: { const: 'workspace.confirmIdentityMapping' },
      ...scope,
      leftEventId: version,
      rightEventId: version,
      expectedLeftBindingVersion: version,
      expectedRightBindingVersion: version,
      expectedMappingVersion: zero,
      reason,
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'method',
      'projectId',
      'taskId',
      'id',
      'expectedVersion',
      'reason',
    ],
    properties: {
      method: { const: 'workspace.revokeIdentityMapping' },
      ...scope,
      id,
      expectedVersion: version,
      reason,
    },
  },
] as const
export interface ScopedAuthor {
  sourceInstanceId: string
  namespace: string
  subjectId: string
}
export interface SourceBinding {
  id: string
  projectId: string
  taskId: string
  sourceInstanceId: string
  externalId: string
  baselineEventId: number
  version: number
  active: boolean
  origin: 'manual' | 'rule'
  primary: boolean
}
export interface SourceBindings {
  bindings: SourceBinding[]
  primaryEventId: number | null
}
export interface IdentityMapping {
  id: string
  projectId: string
  taskId: string
  leftEventId: number
  rightEventId: number
  left: ScopedAuthor
  right: ScopedAuthor
  version: number
  active: boolean
}
export interface IdentityMappings {
  mappings: IdentityMapping[]
}
export interface ProjectSourceEvent {
  id: number
  sourceInstanceId: string
  externalId: string
  revision: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  operation: 'upsert' | 'retract'
  occurredAt: string
  receivedAt: string
  excerpt: string
  excerptTruncated: boolean
  author: ScopedAuthor | null
  sourceStatus: 'active' | 'paused' | 'revoked' | 'uninstalled' | 'unknown'
}
export interface ProjectSourceEvents {
  events: ProjectSourceEvent[]
  nextCursor: string | null
}

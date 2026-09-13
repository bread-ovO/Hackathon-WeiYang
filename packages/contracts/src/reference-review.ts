import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const scope = { projectId: id, taskId: id } as const
const reference = {
  ...scope,
  referenceKind: { enum: ['processing', 'manual'] },
  referenceId: id,
} as const
const paging = {
  cursor: {
    type: 'string',
    minLength: 1,
    maxLength: 4096,
    pattern: '^[^\\u0000-\\u001f\\u007f]+$',
  },
  limit: { type: 'integer', minimum: 1, maximum: 50 },
} as const
export const referenceReviewRequestSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectId', 'taskId'],
    properties: {
      method: { const: 'workspace.listReferences' },
      ...scope,
      ...paging,
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectId', 'taskId', 'referenceKind', 'referenceId'],
    properties: {
      method: { const: 'workspace.reviewReference' },
      ...reference,
      ...paging,
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [
      'method',
      'projectId',
      'taskId',
      'referenceKind',
      'referenceId',
      'chosenEventId',
      'knownContentSetDigest',
      'expectedReferenceVersion',
      'reason',
    ],
    properties: {
      method: { const: 'workspace.confirmReference' },
      ...reference,
      chosenEventId: {
        type: 'integer',
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      knownContentSetDigest: {
        type: 'string',
        minLength: 64,
        maxLength: 64,
        pattern: '^[a-f0-9]{64}$',
      },
      expectedReferenceVersion: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$',
      },
    },
  },
] as const
export type ReferenceRequest = FromSchema<{
  readonly oneOf: typeof referenceReviewRequestSchemas
}>
export type ReferenceSummary = {
  kind: 'processing' | 'manual'
  id: string
  version: number
  eventId: number
  sourceInstanceId: string
  externalId: string
  status: 'available' | 'review_required' | 'confirmed' | 'invalidated'
  sourceStatus: 'active' | 'paused' | 'revoked' | 'uninstalled' | 'unknown'
  originalReferenceStatus: 'available' | 'invalidated'
}
export interface ReferenceList {
  references: ReferenceSummary[]
  nextCursor: string | null
}
/** Revisions are opaque: this is a known set, never a claim of server latestness. */
export interface ReferenceReview {
  reference: ReferenceSummary
  knownContentSetDigest: string
  events: {
    id: number
    revision: string
    occurredAt: string
    receivedAt: string
    text: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    operation: 'upsert'
  }[]
  nextCursor: string | null
  /** Explicit manual selection of a whole known message, not relocation of an old excerpt. */
  confirmation: null | {
    eventId: number
    revision: string
    text: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    reason: string
    createdAt: string
    actorId: string
    validity: 'available' | 'valid' | 'unknown' | 'invalid'
  }
}

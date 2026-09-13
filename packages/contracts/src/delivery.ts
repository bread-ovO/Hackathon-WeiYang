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
const scope = { projectId: id, taskId: id } as const
const expectations = {
  expectedTaskVersion: { ...version, minimum: 1 },
  expectedCriteriaVersion: version,
  expectedManualVersion: version,
} as const
const required = [
  'method',
  'projectId',
  'taskId',
  'expectedTaskVersion',
  'expectedCriteriaVersion',
  'expectedManualVersion',
] as const
export const deliveryRequestSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectId', 'taskId'],
    properties: { method: { const: 'workspace.delivery' }, ...scope },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [...required, 'targetUrl'],
    properties: {
      method: { const: 'workspace.startDelivery' },
      ...scope,
      ...expectations,
      targetUrl: {
        type: 'string',
        maxLength: 256,
        pattern:
          '^https://github\\.com/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+/(issues|pull)/[1-9][0-9]*$',
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [...required, 'eventId', 'decision', 'expectedDigest'],
    properties: {
      method: { const: 'workspace.resolveDelivery' },
      ...scope,
      ...expectations,
      eventId: { ...version, minimum: 1 },
      decision: { enum: ['confirm', 'reject'] },
      expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: [...required, 'expectedDigest'],
    properties: {
      method: { const: 'workspace.completeDelivery' },
      ...scope,
      ...expectations,
      expectedDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  },
] as const
export interface DeliveryEvidence {
  eventId: number
  sourceInstanceId: string
  externalId: string
  kind: 'pr' | 'feedback' | 'progress'
  relation: 'supports' | 'opposes' | 'related'
  state: 'linked' | 'pending' | 'rejected' | 'unavailable'
  reason: string
  excerpt: string
  occurredAt: string
  url: string | null
  confirmed: boolean
}
export interface DeliverySummary {
  enabled: boolean
  stale: boolean
  targetUrl: string | null
  digest: string
  backfillLimited: boolean
  conditions: {
    key: 'pr' | 'feedback'
    label: string
    met: boolean
    eventIds: number[]
  }[]
  nextAction: string
  canComplete: boolean
  evidence: DeliveryEvidence[]
  history: { action: string; eventId: number | null; recordedAt: string }[]
}

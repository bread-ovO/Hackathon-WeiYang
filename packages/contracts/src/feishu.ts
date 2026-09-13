import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const uuid = {
  type: 'string',
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
} as const
const chatId = {
  type: 'string',
  maxLength: 256,
  pattern: '^oc_[A-Za-z0-9_-]{1,252}$',
} as const
const positive = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
const timestamp = {
  type: 'integer',
  minimum: 0,
  maximum: 8640000000000000,
} as const
const instant = { ...timestamp, multipleOf: 1000 } as const
const pageToken = { type: 'string', maxLength: 4096 } as const
const recordCursor = { type: 'string', minLength: 1, maxLength: 4096 } as const
const scope = {
  projectId: id,
  chatId,
  credentialId: uuid,
  startTime: instant,
} as const
export const feishuErrorCodes = [
  'FEISHU_AUTH_FAILED',
  'FEISHU_PERMISSION_DENIED',
  'FEISHU_RATE_LIMITED',
  'FEISHU_API_FAILED',
  'FEISHU_HTTP_FAILED',
  'FEISHU_INVALID_RESPONSE',
  'FEISHU_CREDENTIAL_UNAVAILABLE',
  'FEISHU_PAGE_LOOP',
  'FEISHU_PAGE_LIMIT',
  'INGESTION_QUEUE_LIMIT',
  'INGESTION_DATABASE_LIMIT',
  'INGESTION_DISK_LOW',
  'INGESTION_PROBE_UNAVAILABLE',
] as const
export type FeishuConnectionError = (typeof feishuErrorCodes)[number]
export const feishuRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'feishu.list' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'chatId', 'credentialId', 'startTime'],
      properties: { method: { const: 'feishu.connect' }, ...scope },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id', 'enabled'],
      properties: {
        method: { const: 'feishu.setEnabled' },
        id: uuid,
        enabled: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'feishu.revoke' }, id: uuid },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'feishu.sync' }, id: uuid },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'feishu.restartWindow' }, id: uuid },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: {
        method: { const: 'feishu.records' },
        id: uuid,
        cursor: recordCursor,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  ],
} as const
export type FeishuRequest = FromSchema<typeof feishuRequestSchema>
export function createFeishuHostRequestSchema(
  event: typeof import('./index').sourceEventSchema,
) {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['method'],
        properties: { method: { const: 'feishuHost.list' } },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: { method: { const: 'feishuHost.get' }, id: uuid },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'input'],
        properties: {
          method: { const: 'feishuHost.authorize' },
          input: {
            type: 'object',
            additionalProperties: false,
            required: [
              'projectId',
              'chatId',
              'credentialId',
              'startTime',
              'endTime',
            ],
            properties: { ...scope, endTime: instant },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id', 'enabled'],
        properties: {
          method: { const: 'feishuHost.setEnabled' },
          id: uuid,
          enabled: { type: 'boolean' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: { method: { const: 'feishuHost.revoke' }, id: uuid },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'method',
          'id',
          'expectedGrantVersion',
          'expectedPollVersion',
          'expectedPageToken',
          'expectedWindowStart',
          'expectedWindowEnd',
          'events',
          'nextPageToken',
          'nextPollAt',
        ],
        properties: {
          method: { const: 'feishuHost.receiveBatch' },
          id: uuid,
          expectedGrantVersion: positive,
          expectedPollVersion: positive,
          expectedPageToken: pageToken,
          expectedWindowStart: instant,
          expectedWindowEnd: instant,
          events: { type: 'array', maxItems: 50, items: event },
          nextPageToken: pageToken,
          nextPollAt: timestamp,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'method',
          'id',
          'expectedGrantVersion',
          'expectedPollVersion',
          'errorCode',
          'nextPollAt',
        ],
        properties: {
          method: { const: 'feishuHost.recordFailure' },
          id: uuid,
          expectedGrantVersion: positive,
          expectedPollVersion: positive,
          errorCode: { enum: feishuErrorCodes },
          nextPollAt: timestamp,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'method',
          'id',
          'expectedGrantVersion',
          'expectedPollVersion',
          'until',
        ],
        properties: {
          method: { const: 'feishuHost.beginWindow' },
          id: uuid,
          expectedGrantVersion: positive,
          expectedPollVersion: positive,
          until: instant,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'method',
          'id',
          'expectedGrantVersion',
          'expectedPollVersion',
        ],
        properties: {
          method: { const: 'feishuHost.restartWindow' },
          id: uuid,
          expectedGrantVersion: positive,
          expectedPollVersion: positive,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: {
          method: { const: 'feishuHost.records' },
          id: uuid,
          cursor: recordCursor,
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'credentialId'],
        properties: {
          method: { const: 'feishuHost.getCooldown' },
          credentialId: uuid,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'credentialId', 'notBefore'],
        properties: {
          method: { const: 'feishuHost.recordCooldown' },
          credentialId: uuid,
          notBefore: timestamp,
        },
      },
    ],
  } as const
}
export type FeishuHostRequest = FromSchema<
  ReturnType<typeof createFeishuHostRequestSchema>
>
export interface FeishuConnection {
  windowActive: boolean
  windowStart: number
  windowEnd: number
  id: string
  projectId: string
  chatId: string
  credentialId: string
  grantVersion: number
  status: 'active' | 'paused' | 'revoked' | 'error'
  startTime: number
  completedThrough: number | null
  nextPollAt: number
  lastSuccessAt: string | null
  errorCode: FeishuConnectionError | null
  failureCount: number
  eventCount: number
}
export interface FeishuAuthorized extends FeishuConnection {
  enabled: boolean
  revoked: boolean
  pollVersion: number
  pageToken: string
}
export interface FeishuSnapshot {
  connections: FeishuConnection[]
}
export interface FeishuRecords {
  records: {
    id: number
    externalId: string
    revision: string
    occurredAt: string
    receivedAt: string
    text: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    operation: 'upsert' | 'retract'
  }[]
  nextCursor: string | null
}
export interface FeishuCooldown {
  notBefore: number
  failureCount: number
}

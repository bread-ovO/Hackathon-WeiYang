import type { FromSchema } from 'json-schema-to-ts'
import { ajv, idSchema } from './validation'
export const pauseCodes = [
  'SOURCE_DISABLED',
  'SOURCE_PAUSED',
  'QUEUE_LIMIT',
  'DISK_LIMIT',
  'DISK_UNAVAILABLE',
  'EVENT_TOO_LARGE',
  'PAGE_TOO_LARGE',
  'REVISION_CONTENT_CONFLICT',
  'INVALID_SOURCE_EVENT',
  'NO_HANDLER',
  'CLOCK_CHANGED',
  'STORAGE_ERROR',
] as const
export const healthRequestSchema = {
  type: 'object',
  properties: { method: { const: 'health' } },
  required: ['method'],
  additionalProperties: false,
} as const
export const capacitySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    eventBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
    pageBytes: { type: 'integer', minimum: 1024, maximum: 16777216 },
    pageEvents: { type: 'integer', minimum: 1, maximum: 1000 },
    cursorBytes: { type: 'integer', minimum: 1, maximum: 4096 },
    queueHigh: { type: 'integer', minimum: 1, maximum: 100000 },
    queueLow: { type: 'integer', minimum: 0, maximum: 99999 },
    diskBytes: { type: 'integer', minimum: 67108864, maximum: 10737418240 },
    reserveBytes: { type: 'integer', minimum: 1048576, maximum: 1073741824 },
  },
} as const
export type CapacityUpdate = FromSchema<typeof capacitySchema>
const requestSchema = {
  anyOf: [
    healthRequestSchema,
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'sourceId'],
      properties: { method: { const: 'resumeSource' }, sourceId: idSchema },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'limits'],
      properties: {
        method: { const: 'updateCapacity' },
        limits: capacitySchema,
      },
    },
  ],
} as const
export type CoreRequest = FromSchema<typeof requestSchema>
const validateRequest = ajv.compile<CoreRequest>(requestSchema)
export function parseCoreRequest(value: unknown): CoreRequest {
  if (!validateRequest(value)) throw new Error('INVALID_REQUEST')
  return value
}
const count = { type: 'integer', minimum: 0 } as const
export const healthSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status',
    'schemaVersion',
    'sqliteVersion',
    'eventCount',
    'jobCount',
    'processingStatus',
    'queue',
    'resources',
    'pauses',
    'searchReady',
  ],
  properties: {
    status: { const: 'ready' },
    schemaVersion: count,
    sqliteVersion: idSchema,
    eventCount: count,
    jobCount: count,
    processingStatus: { enum: ['idle', 'running', 'paused'] },
    searchReady: { type: 'boolean' },
    queue: {
      type: 'object',
      additionalProperties: false,
      required: ['depth', 'running', 'dead', 'oldestAgeMs'],
      properties: {
        depth: count,
        running: count,
        dead: count,
        oldestAgeMs: count,
      },
    },
    resources: {
      type: 'object',
      additionalProperties: false,
      required: [
        'usedBytes',
        'availableBytes',
        'maxBytes',
        'queueHigh',
        'queueLow',
      ],
      properties: {
        usedBytes: count,
        availableBytes: { anyOf: [count, { type: 'null' }] },
        maxBytes: count,
        queueHigh: count,
        queueLow: count,
      },
    },
    pauses: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceId', 'code'],
        properties: {
          sourceId: { anyOf: [idSchema, { type: 'null' }] },
          code: { enum: pauseCodes },
        },
      },
    },
  },
} as const
export type Health = FromSchema<typeof healthSchema>
export const coreReplySchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'data'],
      properties: { ok: { const: true }, data: healthSchema },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'error'],
      properties: {
        ok: { const: false },
        error: {
          enum: ['CORE_UNAVAILABLE', 'INVALID_REQUEST', 'INTERNAL_ERROR'],
        },
      },
    },
  ],
} as const
export type CoreReply = FromSchema<typeof coreReplySchema>
const validateReply = ajv.compile<CoreReply>(coreReplySchema)
export function parseCoreReply(value: unknown): CoreReply {
  if (!validateReply(value)) throw new Error('INVALID_REPLY')
  return value
}
export interface DesktopBridge {
  health(): Promise<CoreReply>
  resumeSource(sourceId: string): Promise<CoreReply>
  updateCapacity(limits: CapacityUpdate): Promise<CoreReply>
}

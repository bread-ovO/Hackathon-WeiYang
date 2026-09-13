import type { FromSchema } from 'json-schema-to-ts'
export const ingestionLimitSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    maxQueuedJobs: { type: 'integer', minimum: 1, maximum: 100000 },
    maxDatabaseBytes: {
      type: 'integer',
      minimum: 1048576,
      maximum: 8589934592,
    },
    minFreeDiskBytes: {
      type: 'integer',
      minimum: 1048576,
      maximum: 17179869184,
    },
  },
} as const
export type IngestionLimitsPatch = FromSchema<typeof ingestionLimitSchema>
export interface IngestionLimits {
  maxQueuedJobs: number
  maxDatabaseBytes: number
  minFreeDiskBytes: number
}
export const ingestionRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'ingestion.status' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'patch'],
      properties: {
        method: { const: 'ingestion.configure' },
        patch: ingestionLimitSchema,
      },
    },
  ],
} as const
export type IngestionRequest = FromSchema<typeof ingestionRequestSchema>
export interface IngestionStatus {
  paused: boolean
  reason:
    | 'queue_limit'
    | 'database_limit'
    | 'disk_low'
    | 'probe_unavailable'
    | null
  pendingCount: number
  databaseBytes: number | null
  freeDiskBytes: number | null
  limits: IngestionLimits
}

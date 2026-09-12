import type { FromSchema } from 'json-schema-to-ts'

export const processingRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'processing.status' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'enabled'],
      properties: {
        method: { const: 'processing.configure' },
        enabled: { type: 'boolean' },
      },
    },
  ],
} as const
export type ProcessingRequest = FromSchema<typeof processingRequestSchema>
export interface ProcessingStatus {
  enabled: boolean
  state: 'idle' | 'running' | 'paused' | 'error'
  pendingCount: number
  processedCount: number
  candidateCount: number
  reviewRequiredCount: number
  lastProcessedAt: string | null
  errorCode: 'PROCESSING_FAILED' | null
}

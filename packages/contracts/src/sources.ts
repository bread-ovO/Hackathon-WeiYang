import type { FromSchema } from 'json-schema-to-ts'
const projectId = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const id = { ...projectId, maxLength: 128 } as const
export const sourcesRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'sources.list' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId'],
      properties: { method: { const: 'sources.chooseFile' }, projectId },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'sources.sync' }, id },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'sources.revoke' }, id },
    },
  ],
} as const
/** Host-only capability: only a native file picker may originate this request. */
export const importFileRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'path', 'projectId'],
  properties: {
    method: { const: 'sources.importFile' },
    projectId,
    path: {
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      pattern: '^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\u0000]+$',
    },
  },
} as const
export type SourcesRequest = FromSchema<typeof sourcesRequestSchema>
export type ImportFileRequest = FromSchema<typeof importFileRequestSchema>
export const sourceErrorCodes = [
  'FILE_UNAVAILABLE',
  'UNSAFE_PATH',
  'FILE_TOO_LARGE',
  'LINE_TOO_LARGE',
  'FILE_CHANGED',
  'INVALID_UTF8',
  'INVALID_JSONL',
  'INVALID_SOURCE_EVENT',
  'INVALID_CURSOR',
  'INVALID_MANIFEST',
  'SOURCE_REVISION_CONFLICT',
  'IMPORT_FAILED',
  'IMPORT_INVALID_DATA',
  'IMPORT_LIMIT_EXCEEDED',
] as const
export type SourceErrorCode = (typeof sourceErrorCodes)[number]
/** Deliberate projection: no local path, raw cursor, source text or exception messages. */
export interface SourceSummary {
  id: string
  projectId: string
  displayName: string
  status: 'active' | 'revoked' | 'error'
  grantVersion: number
  lastSuccessAt: string | null
  eventCount: number
  errorCode: SourceErrorCode | null
}
export interface SourcesSnapshot {
  sources: SourceSummary[]
  cancelled?: boolean
}

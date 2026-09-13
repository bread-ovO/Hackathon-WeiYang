import type { FromSchema } from 'json-schema-to-ts'
const projectId = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const id = { ...projectId, maxLength: 128 } as const
/** Built-in coding-agent session sources the renderer may ask the host to open. */
export const sessionSourceKinds = ['claude-code', 'codex'] as const
export type SessionSourceKind = (typeof sessionSourceKinds)[number]
const sessionKind = { enum: sessionSourceKinds } as const
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
      required: ['method', 'projectId', 'kind'],
      properties: {
        method: { const: 'sources.authorizeDirectory' },
        projectId,
        kind: sessionKind,
      },
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
const hostPath = {
  type: 'string',
  minLength: 1,
  maxLength: 4096,
  pattern: '^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\u0000]+$',
} as const
/** Host-only capability: only a native file picker may originate this request. */
export const importFileRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'path', 'projectId'],
  properties: {
    method: { const: 'sources.importFile' },
    projectId,
    path: hostPath,
  },
} as const
/** Host-only capability: only a native directory picker may originate this request. */
export const importDirectoryRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'path', 'projectId', 'kind'],
  properties: {
    method: { const: 'sources.importDirectory' },
    projectId,
    kind: sessionKind,
    path: hostPath,
  },
} as const
export type SourcesRequest = FromSchema<typeof sourcesRequestSchema>
export type ImportFileRequest = FromSchema<typeof importFileRequestSchema>
export type ImportDirectoryRequest = FromSchema<
  typeof importDirectoryRequestSchema
>
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
/** Aggregate outcome of a directory import; never carries paths or per-file detail. */
export interface DirectoryImportSummary {
  files: number
  imported: number
  skipped: number
  truncated: boolean
}
export interface SourcesSnapshot {
  sources: SourceSummary[]
  cancelled?: boolean
  directoryImport?: DirectoryImportSummary
}

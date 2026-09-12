import {
  pluginsRequestSchema,
  type PluginTrialInput,
  type PluginSnapshot,
} from './plugins'
import {
  createPluginHostRequestSchema,
  type PluginHostRequest,
} from './plugin-host'
export * from './plugins'
export * from './plugin-host'
import {
  credentialRequestSchema,
  type CredentialImportInput,
  type CredentialsSnapshot,
} from './credentials'
export * from './credentials'
import {
  exportSaveRequestSchema,
  exportBuildRequestSchema,
  type ExportBuildRequest,
  type ExportScope,
  type ExportReceipt,
} from './export'
export * from './export'
import {
  sourcesRequestSchema,
  importFileRequestSchema,
  type ImportFileRequest,
  type SourcesSnapshot,
} from './sources'
export * from './sources'
import {
  workspaceRequestSchema,
  type WorkspaceSnapshot,
  type WorkspaceQuery,
  type WorkspaceDetail,
} from './workspace'
export * from './workspace'
import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

// JSON Schema is the runtime boundary; TypeScript types are derived from it.
export const sourceEventSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'sourceInstanceId',
    'externalId',
    'revision',
    'occurredAt',
    'role',
    'text',
  ],
  properties: {
    schemaVersion: { const: 1 },
    sourceInstanceId: { type: 'string', minLength: 1, maxLength: 128 },
    externalId: { type: 'string', minLength: 1, maxLength: 256 },
    revision: { type: 'string', minLength: 1, maxLength: 128 },
    occurredAt: { type: 'string', format: 'date-time' },
    role: { enum: ['user', 'assistant', 'tool', 'system'] },
    text: { type: 'string', maxLength: 65536 },
  },
} as const
export type SourceEvent = FromSchema<typeof sourceEventSchema>
const ajv = new Ajv({ allErrors: true })
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) => {
    const m =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
        value,
      )
    if (!m || !Number.isFinite(Date.parse(value))) return false
    const year = Number(m[1]),
      month = Number(m[2]),
      day = Number(m[3])
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= days[month - 1]! &&
      Number(m[4]) < 24 &&
      Number(m[5]) < 60 &&
      Number(m[6]) < 60
    )
  },
})
// Desktop dates are canonical UTC input; reject calendar rollover and ambiguous local dates.
ajv.addFormat('workspace-date-time', {
  type: 'string',
  validate: (value: string) => {
    const m =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
        value,
      )
    if (
      !m ||
      Number(m[1]) < 1 ||
      Number(m[4]) > 23 ||
      Number(m[5]) > 59 ||
      Number(m[6]) > 59
    )
      return false
    const time = Date.parse(value)
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
    )
  },
})
export const validateSourceEvent = ajv.compile<SourceEvent>(sourceEventSchema)
export function parseSourceEvent(value: unknown): SourceEvent {
  if (!validateSourceEvent(value)) throw new Error('INVALID_SOURCE_EVENT')
  return value
}
export const healthRequestSchema = {
  type: 'object',
  properties: { method: { const: 'health' } },
  required: ['method'],
  additionalProperties: false,
} as const
const coreRequestSchema = {
  oneOf: [
    healthRequestSchema,
    workspaceRequestSchema,
    sourcesRequestSchema,
    exportSaveRequestSchema,
    credentialRequestSchema,
    pluginsRequestSchema,
  ],
} as const
export type CoreRequest = FromSchema<typeof coreRequestSchema>
const validateRequest = ajv.compile<CoreRequest>(coreRequestSchema)
export function parseCoreRequest(value: unknown): CoreRequest {
  if (!validateRequest(value)) throw new Error('INVALID_REQUEST')
  if (
    value.method === 'workspace.replaceCriteria' &&
    (new Set(value.criteria.map((c) => c.id)).size !== value.criteria.length ||
      value.criteria.reduce((sum, c) => sum + c.description.length + 1, 0) >
        16384)
  )
    throw new Error('INVALID_REQUEST')
  return value
}
export type HostRequest =
  | Exclude<
      CoreRequest,
      {
        method:
          | 'sources.chooseFile'
          | 'exports.save'
          | 'credentials.list'
          | 'credentials.importFile'
          | 'credentials.remove'
          | 'plugins.list'
          | 'plugins.inspect'
          | 'plugins.trial'
          | 'plugins.activate'
          | 'plugins.disable'
          | 'plugins.uninstall'
          | 'plugins.sync'
      }
    >
  | ImportFileRequest
  | ExportBuildRequest
  | PluginHostRequest
const validateImportFile = ajv.compile<ImportFileRequest>(
  importFileRequestSchema,
)
/** Internal host validation never grants renderer access to a filesystem path. */
const validateExportBuild = ajv.compile<ExportBuildRequest>(
  exportBuildRequestSchema,
)
const validatePluginHost = ajv.compile<PluginHostRequest>(
  createPluginHostRequestSchema(sourceEventSchema),
)
export function parseHostRequest(value: unknown): HostRequest {
  if (validatePluginHost(value)) {
    if (value.method === 'pluginHost.activate') {
      try {
        if (
          new TextEncoder().encode(JSON.stringify(value.input.manifest))
            .byteLength > 65536
        )
          throw new Error('INVALID_REQUEST')
      } catch {
        throw new Error('INVALID_REQUEST')
      }
    }
    return value
  }
  if (validateExportBuild(value)) return value
  if (validateImportFile(value)) return value
  const request = parseCoreRequest(value)
  if (
    request.method === 'sources.chooseFile' ||
    request.method === 'exports.save' ||
    request.method === 'credentials.list' ||
    request.method === 'credentials.importFile' ||
    request.method === 'credentials.remove' ||
    request.method === 'plugins.list' ||
    request.method === 'plugins.inspect' ||
    request.method === 'plugins.trial' ||
    request.method === 'plugins.activate' ||
    request.method === 'plugins.disable' ||
    request.method === 'plugins.uninstall' ||
    request.method === 'plugins.sync'
  )
    throw new Error('INVALID_REQUEST')
  return request
}
export interface Health {
  status: 'ready'
  schemaVersion: number
  sqliteVersion: string
  eventCount: number
  jobCount: number
}
export type CoreReply<T = Health> =
  | { ok: true; data: T }
  | {
      ok: false
      error:
        | 'CORE_UNAVAILABLE'
        | 'INVALID_REQUEST'
        | 'INTERNAL_ERROR'
        | 'VERSION_CONFLICT'
        | 'NOT_FOUND'
        | 'EXPORT_LIMIT_EXCEEDED'
        | 'EXPORT_INVALID_DATA'
        | 'EXPORT_WRITE_FAILED'
        | 'VAULT_UNAVAILABLE'
        | 'VAULT_INVALID_DATA'
        | 'VAULT_WRITE_FAILED'
        | 'VAULT_NOT_FOUND'
        | 'VAULT_SCOPE_MISMATCH'
        | 'PLUGIN_INVALID'
        | 'PLUGIN_UNAVAILABLE'
        | 'PLUGIN_CONFLICT'
        | 'PLUGIN_TRIAL_FAILED'
    }
export interface DesktopBridge {
  health(): Promise<CoreReply>
  plugins: {
    list(): Promise<CoreReply<PluginSnapshot>>
    inspect(): Promise<CoreReply<PluginSnapshot>>
    trial(input: PluginTrialInput): Promise<CoreReply<PluginSnapshot>>
    activate(trialId: string): Promise<CoreReply<PluginSnapshot>>
    disable(id: string): Promise<CoreReply<PluginSnapshot>>
    uninstall(id: string): Promise<CoreReply<PluginSnapshot>>
    sync(id: string): Promise<CoreReply<PluginSnapshot>>
  }
  credentials: {
    list(): Promise<CoreReply<CredentialsSnapshot>>
    importFile(
      input: CredentialImportInput,
    ): Promise<CoreReply<CredentialsSnapshot>>
    remove(id: string): Promise<CoreReply<CredentialsSnapshot>>
  }
  exports: { save(scope: ExportScope): Promise<CoreReply<ExportReceipt>> }
  sources: {
    list(): Promise<CoreReply<SourcesSnapshot>>
    chooseFile(projectId: string): Promise<CoreReply<SourcesSnapshot>>
    sync(id: string): Promise<CoreReply<SourcesSnapshot>>
    revoke(id: string): Promise<CoreReply<SourcesSnapshot>>
  }
  workspace: {
    list(query?: WorkspaceQuery): Promise<CoreReply<WorkspaceSnapshot>>
    detail(
      projectId: string,
      id: string,
      criteriaVersion?: number,
    ): Promise<CoreReply<WorkspaceDetail>>
    replaceCriteria(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.replaceCriteria' }>,
        'method'
      >,
    ): Promise<CoreReply<WorkspaceSnapshot>>
    createProject(name: string): Promise<CoreReply<WorkspaceSnapshot>>
    createTask(
      projectId: string,
      title: string,
    ): Promise<CoreReply<WorkspaceSnapshot>>
    updateTask(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.updateTask' }>,
        'method'
      >,
    ): Promise<CoreReply<WorkspaceSnapshot>>
  }
}

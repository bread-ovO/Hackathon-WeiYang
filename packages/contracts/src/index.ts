import type { PetVoiceState, PetVoicePreferences } from './pet-voice'
export * from './pet-voice'
export * from './pet-voice-pcm'
import type {
  PetContextState,
  PetContextConfig,
  PetContextPreview,
} from './pet-context'
export * from './pet-context'
export * from './pet-context-facts'
import {
  feishuRequestSchema,
  createFeishuHostRequestSchema,
  type FeishuRequest,
  type FeishuHostRequest,
  type FeishuSnapshot,
  type FeishuRecords,
  type FeishuConnectionError,
} from './feishu'
export * from './feishu'
import {
  githubRequestSchema,
  createGithubHostRequestSchema,
  type GithubRequest,
  type GithubHostRequest,
  type GithubSnapshot,
  type GithubRecords,
  type GithubConnectionError,
} from './github'
export * from './github'
import {
  ingestionRequestSchema,
  type IngestionStatus,
  type IngestionLimitsPatch,
} from './ingestion'
export * from './ingestion'
import { processingRequestSchema, type ProcessingStatus } from './processing'
export * from './processing'
export * from './pet-actions'
import {
  petRequestSchemas,
  type PetRequest,
  type PetState,
  type PetChooseReply,
  type PetImportReply,
  type PetSpeechPatch,
} from './pet'
export * from './pet'
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
  importDirectoryRequestSchema,
  type ImportFileRequest,
  type ImportDirectoryRequest,
  type SessionSourceKind,
  type SourcesSnapshot,
} from './sources'
export * from './sources'
import {
  workspaceRequestSchema,
  type WorkspaceSnapshot,
  type WorkspaceQuery,
  type WorkspaceDetail,
  type ReferenceList,
  type ReferenceReview,
  type TimelinePage,
  type PlanChangesPage,
  type PlanChangeResult,
  type PlanChangeProposal,
  type ProjectSourceEvents,
  type SourceBindings,
  type IdentityMappings,
} from './workspace'
export * from './workspace'
import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

// JSON Schema is the runtime boundary; TypeScript types are derived from it.
const metadataIdentity = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
export const sourceEventMetadataSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    author: {
      type: 'object',
      additionalProperties: false,
      required: ['namespace', 'subjectId'],
      properties: { namespace: metadataIdentity, subjectId: metadataIdentity },
    },
    replyToExternalId: metadataIdentity,
  },
} as const
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
    operation: { enum: ['upsert', 'retract'] },
    metadata: sourceEventMetadataSchema,
  },
  allOf: [
    {
      if: {
        required: ['operation'],
        properties: { operation: { const: 'retract' } },
      },
      then: { properties: { text: { const: '' } } },
    },
  ],
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
    githubRequestSchema,
    feishuRequestSchema,
    processingRequestSchema,
    ingestionRequestSchema,
    workspaceRequestSchema,
    sourcesRequestSchema,
    exportSaveRequestSchema,
    credentialRequestSchema,
    pluginsRequestSchema,
    ...petRequestSchemas,
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
          | PetRequest['method']
          | GithubRequest['method']
          | FeishuRequest['method']
          | 'sources.chooseFile'
          | 'sources.authorizeDirectory'
          | 'exports.save'
          | 'credentials.list'
          | 'credentials.importFile'
          | 'credentials.remove'
          | 'plugins.list'
          | 'plugins.startDemo'
          | 'plugins.inspect'
          | 'plugins.trial'
          | 'plugins.activate'
          | 'plugins.disable'
          | 'plugins.uninstall'
          | 'plugins.sync'
          | 'pet.state'
          | 'pet.openImportDialog'
          | 'pet.importChosen'
          | 'pet.select'
          | 'pet.show'
          | 'pet.hide'
      }
    >
  | ImportFileRequest
  | ImportDirectoryRequest
  | ExportBuildRequest
  | PluginHostRequest
  | GithubHostRequest
  | FeishuHostRequest
const validateImportFile = ajv.compile<ImportFileRequest>(
  importFileRequestSchema,
)
const validateImportDirectory = ajv.compile<ImportDirectoryRequest>(
  importDirectoryRequestSchema,
)
/** Internal host validation never grants renderer access to a filesystem path. */
const validateExportBuild = ajv.compile<ExportBuildRequest>(
  exportBuildRequestSchema,
)
const validatePluginHost = ajv.compile<PluginHostRequest>(
  createPluginHostRequestSchema(sourceEventSchema),
)
const validateGithubHost = ajv.compile<GithubHostRequest>(
  createGithubHostRequestSchema(sourceEventSchema),
)
const validateFeishuHost = ajv.compile<FeishuHostRequest>(
  createFeishuHostRequestSchema(sourceEventSchema),
)
export function parseHostRequest(value: unknown): HostRequest {
  if (validateFeishuHost(value)) return value
  if (validateGithubHost(value)) return value
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
  if (validateImportDirectory(value)) return value
  const request = parseCoreRequest(value)
  if (
    request.method === 'feishu.list' ||
    request.method === 'feishu.connect' ||
    request.method === 'feishu.setEnabled' ||
    request.method === 'feishu.revoke' ||
    request.method === 'feishu.sync' ||
    request.method === 'feishu.restartWindow' ||
    request.method === 'feishu.records' ||
    request.method === 'github.list' ||
    request.method === 'github.connect' ||
    request.method === 'github.connectAccount' ||
    request.method === 'github.setEnabled' ||
    request.method === 'github.revoke' ||
    request.method === 'github.sync' ||
    request.method === 'github.records' ||
    request.method === 'pet.voiceState' ||
    request.method === 'pet.configureVoice' ||
    request.method === 'pet.stopVoice' ||
    request.method === 'pet.contextState' ||
    request.method === 'pet.configureContext' ||
    request.method === 'pet.previewContext' ||
    request.method === 'pet.cancelContext' ||
    request.method === 'pet.showContext' ||
    request.method === 'pet.play' ||
    request.method === 'pet.speak' ||
    request.method === 'pet.dismissBubble' ||
    request.method === 'pet.configureSpeech' ||
    request.method === 'pet.configure' ||
    request.method === 'pet.resetPosition' ||
    request.method === 'pet.show' ||
    request.method === 'pet.hide' ||
    request.method === 'pet.installRuntime' ||
    request.method === 'pet.state' ||
    request.method === 'pet.openImportDialog' ||
    request.method === 'pet.cancelImport' ||
    request.method === 'pet.importChosen' ||
    request.method === 'pet.select' ||
    request.method === 'pet.remove' ||
    request.method === 'sources.chooseFile' ||
    request.method === 'sources.authorizeDirectory' ||
    request.method === 'exports.save' ||
    request.method === 'credentials.list' ||
    request.method === 'credentials.importFile' ||
    request.method === 'credentials.remove' ||
    request.method === 'plugins.list' ||
    request.method === 'plugins.startDemo' ||
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
        | 'INVALID_REFERENCE_REVIEW'
        | 'REFERENCE_REVIEW_CONFLICT'
        | 'REFERENCE_RETRACTED'
        | 'REFERENCE_ALREADY_INVALID'
        | FeishuConnectionError
        | 'FEISHU_CANCELLED'
        | 'FEISHU_BUSY'
        | 'FEISHU_NOT_DUE'
        | 'FEISHU_INVALID'
        | 'FEISHU_UNAVAILABLE'
        | 'FEISHU_FAILED'
        | GithubConnectionError
        | 'GITHUB_CANCELLED'
        | 'GITHUB_BUSY'
        | 'GITHUB_NOT_DUE'
        | 'GITHUB_INVALID'
        | 'GITHUB_UNAVAILABLE'
        | 'GITHUB_FAILED'
        | 'CORE_UNAVAILABLE'
        | 'INVALID_REQUEST'
        | 'PET_MODEL_OFFLINE'
        | 'PET_MODEL_TIMEOUT'
        | 'PET_MODEL_INVALID_RESPONSE'
        | 'PET_MODEL_CANCELLED'
        | 'PET_MODEL_UNAVAILABLE'
        | 'PET_MODEL_BUSY'
        | 'PET_VOICE_UNAVAILABLE'
        | 'PET_VOICE_INVALID'
        | 'PET_VOICE_INVALID_PCM'
        | 'PET_VOICE_TOO_LONG'
        | 'PET_VOICE_TIMEOUT'
        | 'PET_VOICE_CANCELLED'
        | 'PET_VOICE_BUSY'
        | 'PET_VOICE_STORAGE'
        | 'PET_VOICE_CONFLICT'
        | 'PET_CONTEXT_STORAGE_ERROR'
        | 'PET_CONTEXT_CONFLICT'
        | 'PET_CONTEXT_EXPIRED'
        | 'PET_CONTEXT_BUDGET'
        | 'PET_CONTEXT_COOLDOWN'
        | 'PET_CONTEXT_INVALID_INPUT'
        | 'PET_CONTEXT_UNAVAILABLE'
        | 'INTERNAL_ERROR'
        | 'ASSOCIATION_INVALID_INPUT'
        | 'ASSOCIATION_NOT_FOUND'
        | 'ASSOCIATION_CONFLICT'
        | 'ASSOCIATION_UNAVAILABLE'
        | 'ASSOCIATION_LIMIT_EXCEEDED'
        | 'ASSOCIATION_CORRUPT_DATA'
        | 'ASSOCIATION_INVALID_CURSOR'
        | 'PLAN_CHANGE_INVALID_INPUT'
        | 'PLAN_CHANGE_NOT_FOUND'
        | 'PLAN_CHANGE_NOT_APPLICABLE'
        | 'VERSION_CONFLICT'
        | 'NOT_FOUND'
        | 'TIMELINE_INVALID_CURSOR'
        | 'TIMELINE_CORRUPT_DATA'
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
        | 'PET_UNAVAILABLE'
        | 'PET_RUNTIME_INVALID'
        | 'PET_OUTCOME_UNKNOWN'
        | 'IMPORT_SESSION_INVALID'
        | 'SOURCE_CHANGED'
        | 'INVALID_STORE'
        | 'UNKNOWN_MODEL'
        | 'STORAGE_LIMIT'
        | 'INGESTION_QUEUE_LIMIT'
        | 'INGESTION_DATABASE_LIMIT'
        | 'INGESTION_DISK_LOW'
        | 'INGESTION_PROBE_UNAVAILABLE'
    }
export interface DesktopBridge {
  onOpenTask(
    callback: (target: { projectId: string; taskId: string }) => void,
  ): () => void

  feishu: {
    list(): Promise<CoreReply<FeishuSnapshot>>
    connect(
      input: Omit<
        Extract<FeishuRequest, { method: 'feishu.connect' }>,
        'method'
      >,
    ): Promise<CoreReply<FeishuSnapshot>>
    setEnabled(id: string, enabled: boolean): Promise<CoreReply<FeishuSnapshot>>
    revoke(id: string): Promise<CoreReply<FeishuSnapshot>>
    sync(id: string): Promise<CoreReply<FeishuSnapshot>>
    restartWindow(id: string): Promise<CoreReply<FeishuSnapshot>>
    records(
      input: Omit<
        Extract<FeishuRequest, { method: 'feishu.records' }>,
        'method'
      >,
    ): Promise<CoreReply<FeishuRecords>>
  }
  github: {
    connectAccount(
      input: Omit<
        Extract<GithubRequest, { method: 'github.connectAccount' }>,
        'method'
      >,
    ): Promise<CoreReply<GithubSnapshot>>
    list(): Promise<CoreReply<GithubSnapshot>>
    connect(
      input: Omit<
        Extract<GithubRequest, { method: 'github.connect' }>,
        'method'
      >,
    ): Promise<CoreReply<GithubSnapshot>>
    setEnabled(id: string, enabled: boolean): Promise<CoreReply<GithubSnapshot>>
    revoke(id: string): Promise<CoreReply<GithubSnapshot>>
    sync(id: string): Promise<CoreReply<GithubSnapshot>>
    records(
      input: Omit<
        Extract<GithubRequest, { method: 'github.records' }>,
        'method'
      >,
    ): Promise<CoreReply<GithubRecords>>
  }
  ingestion: {
    status(): Promise<CoreReply<IngestionStatus>>
    configure(patch: IngestionLimitsPatch): Promise<CoreReply<IngestionStatus>>
  }
  processing: {
    status(): Promise<CoreReply<ProcessingStatus>>
    configure(enabled: boolean): Promise<CoreReply<ProcessingStatus>>
  }
  pet: {
    voiceState(): Promise<CoreReply<PetVoiceState>>
    configureVoice(input: {
      expectedVersion: number
      preferences: Omit<PetVoicePreferences, 'version'>
    }): Promise<CoreReply<PetVoiceState>>
    stopVoice(): Promise<CoreReply<PetVoiceState>>
    contextState(): Promise<CoreReply<PetContextState>>
    configureContext(input: {
      expectedVersion: number
      config: Omit<PetContextConfig, 'version'>
    }): Promise<CoreReply<PetContextState>>
    previewContext(): Promise<CoreReply<PetContextPreview>>
    cancelContext(): Promise<CoreReply<PetContextState>>
    showContext(id: string): Promise<CoreReply<PetContextState>>

    configureSpeech(patch: PetSpeechPatch): Promise<CoreReply<PetState>>
    play(actionId: string): Promise<CoreReply<PetState>>
    speak(input: {
      text: string
      actionId?: string
    }): Promise<CoreReply<PetState>>
    dismissBubble(): Promise<CoreReply<PetState>>
    configure(patch: {
      scale?: number
      alwaysOnTop?: boolean
      clickThrough?: boolean
    }): Promise<CoreReply<PetState>>
    resetPosition(): Promise<CoreReply<PetState>>
    show(): Promise<CoreReply<PetState>>
    hide(): Promise<CoreReply<PetState>>
    installRuntime(): Promise<CoreReply<PetState>>
    state(): Promise<CoreReply<PetState>>
    openImportDialog(): Promise<CoreReply<PetChooseReply>>
    cancelImport(): Promise<CoreReply<{ status: 'cancelled' }>>
    importChosen(
      sessionId: string,
      entry: string,
    ): Promise<CoreReply<PetImportReply>>
    select(modelId: string | null): Promise<CoreReply<PetState>>
    remove(modelId: string): Promise<CoreReply<PetState>>
  }
  health(): Promise<CoreReply>
  plugins: {
    startDemo(): Promise<CoreReply<PluginSnapshot>>
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
    authorizeDirectory(
      projectId: string,
      kind: SessionSourceKind,
    ): Promise<CoreReply<SourcesSnapshot>>
    sync(id: string): Promise<CoreReply<SourcesSnapshot>>
    revoke(id: string): Promise<CoreReply<SourcesSnapshot>>
  }
  workspace: {
    sourceEvents(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.sourceEvents' }>,
        'method'
      >,
    ): Promise<CoreReply<ProjectSourceEvents>>
    sourceBindings(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.sourceBindings' }>,
        'method'
      >,
    ): Promise<CoreReply<SourceBindings>>
    bindSourceObject(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.bindSourceObject' }>,
        'method'
      >,
    ): Promise<CoreReply<SourceBindings>>
    revokeSourceBinding(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.revokeSourceBinding' }>,
        'method'
      >,
    ): Promise<CoreReply<SourceBindings>>
    identityMappings(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.identityMappings' }>,
        'method'
      >,
    ): Promise<CoreReply<IdentityMappings>>
    confirmIdentityMapping(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.confirmIdentityMapping' }>,
        'method'
      >,
    ): Promise<CoreReply<IdentityMappings>>
    revokeIdentityMapping(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.revokeIdentityMapping' }>,
        'method'
      >,
    ): Promise<CoreReply<IdentityMappings>>
    reevaluatePlanChange(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.reevaluatePlanChange' }>,
        'method'
      >,
    ): Promise<CoreReply<PlanChangeProposal>>
    planChanges(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.planChanges' }>,
        'method'
      >,
    ): Promise<CoreReply<PlanChangesPage>>
    confirmPlanChange(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.confirmPlanChange' }>,
        'method'
      >,
    ): Promise<CoreReply<PlanChangeResult>>
    timeline(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.timeline' }>,
        'method'
      >,
    ): Promise<CoreReply<TimelinePage>>
    listReferences(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.listReferences' }>,
        'method'
      >,
    ): Promise<CoreReply<ReferenceList>>
    reviewReference(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.reviewReference' }>,
        'method'
      >,
    ): Promise<CoreReply<ReferenceReview>>
    confirmReference(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.confirmReference' }>,
        'method'
      >,
    ): Promise<CoreReply<ReferenceReview>>
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
    mergeTasks(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.mergeTasks' }>,
        'method'
      >,
    ): Promise<CoreReply<WorkspaceSnapshot>>
    updateTask(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.updateTask' }>,
        'method'
      >,
    ): Promise<CoreReply<WorkspaceSnapshot>>
  }
}
export * from './github-account'

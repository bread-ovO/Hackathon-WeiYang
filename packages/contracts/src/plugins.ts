import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
export const pluginTrialInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['inspectionId', 'projectId'],
  properties: {
    inspectionId: id,
    projectId: { ...id, maxLength: 256 },
    credentialId: id,
  },
} as const
export type PluginTrialInput = FromSchema<typeof pluginTrialInputSchema>
export const pluginsRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'plugins.list' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'plugins.inspect' } },
    },
    {
      ...pluginTrialInputSchema,
      required: ['method', ...pluginTrialInputSchema.required],
      properties: {
        ...pluginTrialInputSchema.properties,
        method: { const: 'plugins.trial' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'trialId'],
      properties: { method: { const: 'plugins.activate' }, trialId: id },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'plugins.disable' }, id },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'plugins.uninstall' }, id },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'plugins.sync' }, id },
    },
  ],
} as const
export type PluginsRequest = FromSchema<typeof pluginsRequestSchema>
export interface InstalledPlugin {
  id: string
  projectId: string
  displayName: string
  version: string
  digest: string
  status: 'active' | 'disabled' | 'error'
  grantVersion: number
  eventCount: number
  lastSuccessAt: string | null
}
export interface PluginInspection {
  inspectionId: string
  id: string
  displayName: string
  version: string
  digest: string
  kind: 'http-json' | 'local-jsonl'
  domain?: string
  file?: string
  credentialRequired: boolean
  permissionChanged: boolean
  previousScope?: string
  credentialPurpose?: string
}
export interface PluginTrial {
  trialId: string
  eventCount: number
  done: boolean
}
export interface PluginSnapshot {
  plugins: InstalledPlugin[]
  inspection?: PluginInspection
  trial?: PluginTrial
  cancelled?: boolean
}

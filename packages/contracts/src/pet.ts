import {petVoiceRequestSchemas,type PetVoicePlayback} from './pet-voice'
import { petContextRequestSchemas } from './pet-context'
export * from './pet-context'
import type { PetActionCatalog, PetPresentation } from './pet-actions'
import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

// PET02 renderer-facing contracts. The renderer never sees absolute paths:
// directory selection lives in the main process and imports reference a
// session-scoped entry file name only.
export const petSpeechPatchSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    frequency: { enum: ['low', 'normal'] },
    quietStart: { type: 'integer', minimum: 0, maximum: 1439 },
    quietEnd: { type: 'integer', minimum: 0, maximum: 1439 },
    pausedUntil: {
      anyOf: [
        { type: 'integer', minimum: 0, maximum: 8640000000000000 },
        { type: 'null' },
      ],
    },
  },
} as const
export type PetSpeechPatch = FromSchema<typeof petSpeechPatchSchema>
export interface PetSpeechPreferences {
  enabled: boolean
  frequency: 'low' | 'normal'
  quietStart: number
  quietEnd: number
  pausedUntil: number | null
}
export interface PetSpeechState {
  preferences: PetSpeechPreferences
  nextAt: number | null
  todayCount: number
  status: 'disabled' | 'paused' | 'quiet' | 'suppressed' | 'waiting' | 'error'
}
export const petRequestSchemas = [
  ...petContextRequestSchemas,
  ...petVoiceRequestSchemas,
  {
    type: 'object',
    properties: {
      method: { const: 'pet.configureSpeech' },
      patch: petSpeechPatchSchema,
    },
    required: ['method', 'patch'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.play' },
      actionId: {
        type: 'string',
        pattern: '^(motion:[0-9]{1,2}:[0-9]{1,2}|expression:[0-9]{1,2})$',
      },
    },
    required: ['method', 'actionId'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.speak' },
      input: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 240 },
          actionId: {
            type: 'string',
            pattern: '^(motion:[0-9]{1,2}:[0-9]{1,2}|expression:[0-9]{1,2})$',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    required: ['method', 'input'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.dismissBubble' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.configure' },
      patch: {
        type: 'object',
        properties: {
          scale: { type: 'number', minimum: 0.5, maximum: 2 },
          alwaysOnTop: { type: 'boolean' },
          clickThrough: { type: 'boolean' },
        },
        minProperties: 1,
        additionalProperties: false,
      },
    },
    required: ['method', 'patch'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.resetPosition' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.show' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.hide' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.installRuntime' } },
    required: ['method'],
    additionalProperties: false,
  },

  {
    type: 'object',
    properties: { method: { const: 'pet.state' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.openImportDialog' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.importChosen' },
      sessionId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
      entry: { type: 'string', minLength: 1, maxLength: 512 },
    },
    required: ['method', 'sessionId', 'entry'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.select' },
      modelId: {
        anyOf: [
          { type: 'string', pattern: '^[a-f0-9]{64}$' },
          { type: 'null' },
        ],
      },
    },
    required: ['method', 'modelId'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.cancelImport' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.remove' },
      modelId: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
    required: ['method', 'modelId'],
    additionalProperties: false,
  },
] as const

// Model management is main-only. The SQLite worker never accepts these requests.
const petRequestSchema = { oneOf: petRequestSchemas } as const
export type PetRequest = FromSchema<typeof petRequestSchema>
const validatePetRequest = new Ajv({ strict: true }).compile<PetRequest>(
  petRequestSchema,
)
export function parsePetRequest(value: unknown): PetRequest {
  if (!validatePetRequest(value)) throw new Error('INVALID_PET_REQUEST')
  return structuredClone(value)
}

export interface PetModel {
  id: string
  entry: string
  importedAt: string
  totalBytes: number
}
export interface PetPreferences {
  scale: number
  alwaysOnTop: boolean
  clickThrough: boolean
}
export interface PetState {
  voice?: PetVoicePlayback
  speech?: PetSpeechState
  catalog?: PetActionCatalog
  presentation?: PetPresentation | null
  preferences?: PetPreferences
  currentModelId: string | null
  /** Whether the pet window is wanted on screen right now. */
  display: boolean
  runtimeReady?: boolean
  renderStatus?: 'hidden' | 'loading' | 'ready' | 'error'
  renderError?: string
  models: PetModel[]
}
export type PetChooseReply =
  | { status: 'cancelled' }
  | { status: 'no-model'; cmo3Found: boolean }
  | { status: 'ready'; sessionId: string; entry: string; entries: string[] }
  | { status: 'choose'; sessionId: string; entries: string[] }
export interface PetModelIssue {
  code: string
  resource: string
  message: string
}
export type PetImportReply =
  | { status: 'imported' | 'duplicate'; model: PetModel }
  | { status: 'invalid'; issues: PetModelIssue[] }

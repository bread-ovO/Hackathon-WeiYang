import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'
import type { PetVoicePcm } from './pet-voice-pcm'
const version = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
const fields = {
  enabled: { type: 'boolean' },
  voiceId: {
    anyOf: [
      {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
      },
      { type: 'null' },
    ],
  },
  volume: { type: 'number', minimum: 0, maximum: 1 },
  rate: { type: 'number', minimum: 0.75, maximum: 1.25 },
} as const
const enabledVoice = [
  {
    if: { properties: { enabled: { const: true } }, required: ['enabled'] },
    then: { properties: { voiceId: { type: 'string', minLength: 1 } } },
  },
] as const
export const petVoicePreferencesSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'enabled', 'voiceId', 'volume', 'rate'],
  properties: { version, ...fields },
  allOf: enabledVoice,
} as const
export type PetVoicePreferences = FromSchema<typeof petVoicePreferencesSchema>
export interface PetVoiceOption {
  id: string
  name: string
  language: string
}
export interface PetVoiceState {
  preferences: PetVoicePreferences
  voices: PetVoiceOption[]
  available: boolean
  status:
    | 'disabled'
    | 'idle'
    | 'synthesizing'
    | 'ready'
    | 'playing'
    | 'error'
    | 'unavailable'
  error: string | null
  currentId: string | null
}
export interface PetVoiceAudio {
  id: string
  version: number
  pcm: PetVoicePcm
  volume: number
}
export interface PetVoicePlayback {
  id: string | null
  version: number
  status: PetVoiceState['status']
}
export const petVoiceRequestSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['method'],
    properties: { method: { const: 'pet.voiceState' } },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'expectedVersion', 'preferences'],
    properties: {
      method: { const: 'pet.configureVoice' },
      expectedVersion: version,
      preferences: {
        type: 'object',
        additionalProperties: false,
        required: ['enabled', 'voiceId', 'volume', 'rate'],
        properties: fields,
        allOf: enabledVoice,
      },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method'],
    properties: { method: { const: 'pet.stopVoice' } },
  },
] as const
const validate = new Ajv({ strict: true }).compile(petVoicePreferencesSchema)
export function parsePetVoicePreferences(value: unknown): PetVoicePreferences {
  if (!validate(value)) throw new Error('PET_VOICE_INVALID')
  return structuredClone(value) as PetVoicePreferences
}

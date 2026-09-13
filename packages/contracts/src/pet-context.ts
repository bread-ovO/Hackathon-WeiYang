import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const version = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
const fields = {
  enabled: { type: 'boolean' },
  projectIds: { type: 'array', items: id, maxItems: 3, uniqueItems: true },
  useModel: { type: 'boolean' },
  model: {
    type: 'string',
    maxLength: 128,
    pattern: '^(?:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})?$',
    not: { pattern: '(?::|-)[cC][lL][oO][uU][dD]$' },
  },
} as const
export const petContextConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'enabled', 'projectIds', 'useModel', 'model'],
  properties: { version, ...fields },
  allOf: [
    {
      if: { properties: { useModel: { const: true } }, required: ['useModel'] },
      then: { properties: { model: { type: 'string', minLength: 1 } } },
    },
  ],
} as const
export type PetContextConfig = FromSchema<typeof petContextConfigSchema>
const config = {
  ...petContextConfigSchema,
  required: ['enabled', 'projectIds', 'useModel', 'model'],
  properties: fields,
} as const
export const petContextRequestSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['method'],
    properties: { method: { const: 'pet.contextState' } },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'expectedVersion', 'config'],
    properties: {
      method: { const: 'pet.configureContext' },
      expectedVersion: version,
      config,
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method'],
    properties: { method: { const: 'pet.previewContext' } },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method'],
    properties: { method: { const: 'pet.cancelContext' } },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'id'],
    properties: { method: { const: 'pet.showContext' }, id },
  },
] as const
export interface PetContextState {
  config: PetContextConfig
  busy: boolean
  lastResult: 'none' | 'local' | 'model' | 'fallback' | 'cancelled' | 'error'
  error: string | null
}
export interface PetContextPreview {
  id: string
  text: string
  reason: string
  hasReference: boolean
  mode: 'local' | 'model' | 'fallback'
}
const validate = new Ajv({ strict: true }).compile<PetContextConfig>(
  petContextConfigSchema,
)
export function parsePetContextConfig(value: unknown): PetContextConfig {
  if (!validate(value)) throw Error('INVALID_PET_CONTEXT_CONFIG')
  return structuredClone(value)
}

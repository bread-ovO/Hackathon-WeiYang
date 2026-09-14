import type { FromSchema } from 'json-schema-to-ts'
export const modelConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'enabled', 'baseUrl', 'model', 'credentialId'],
  properties: {
    provider: {
      enum: [
        'responses',
        'chat-completions',
        'codex-cli',
        'claude-cli',
        'kimi-cli',
      ],
    },
    enabled: { type: 'boolean' },
    baseUrl: { type: 'string', maxLength: 2048 },
    model: { type: 'string', maxLength: 128, pattern: '^[^\\u0000-\\u001f]*$' },
    credentialId: { type: 'string', maxLength: 128 },
  },
} as const
export type ModelConfig = FromSchema<typeof modelConfigSchema>
export const modelProviderRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'modelProvider.status' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'config'],
      properties: {
        method: { const: 'modelProvider.configure' },
        config: modelConfigSchema,
      },
    },
  ],
} as const
export interface ModelProviderSnapshot {
  config: ModelConfig
  availableClis: string[]
}

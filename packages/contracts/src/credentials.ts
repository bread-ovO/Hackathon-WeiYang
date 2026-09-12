import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
export const credentialImportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'domain', 'purpose'],
  properties: {
    label: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      pattern: '^(?!\\s*$)[^\\u0000-\\u001f\\u007f]+$',
    },
    domain: {
      type: 'string',
      minLength: 3,
      maxLength: 253,
      pattern:
        '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$',
    },
    purpose: { enum: ['source', 'model'] },
  },
} as const
export type CredentialImportInput = FromSchema<typeof credentialImportSchema>
/** These methods stay in main. No request or reply carries secret material or file paths. */
export const credentialRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'credentials.list' } },
    },
    {
      ...credentialImportSchema,
      required: ['method', ...credentialImportSchema.required],
      properties: {
        ...credentialImportSchema.properties,
        method: { const: 'credentials.importFile' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'credentials.remove' }, id },
    },
  ],
} as const
export type CredentialRequest = FromSchema<typeof credentialRequestSchema>
export interface CredentialSummary {
  id: string
  label: string
  domain: string
  purpose: 'source' | 'model'
  createdAt: string
}
export interface CredentialsSnapshot {
  credentials: CredentialSummary[]
  encryptionAvailable: boolean
  cancelled?: boolean
}

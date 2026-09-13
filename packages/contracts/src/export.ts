import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
/** Explicit source-text choice; absence must not silently opt the user into exporting bodies. */
export const exportScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'includeSourceText'],
  properties: {
    projectId: id,
    taskIds: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: id,
    },
    includeSourceText: { type: 'boolean' },
  },
} as const
export type ExportScope = FromSchema<typeof exportScopeSchema>
export const exportSaveRequestSchema = {
  ...exportScopeSchema,
  required: ['method', ...exportScopeSchema.required],
  properties: {
    ...exportScopeSchema.properties,
    method: { const: 'exports.save' },
  },
} as const
/** Only main can request an export bundle, after native file selection. */
export const exportBuildRequestSchema = {
  ...exportScopeSchema,
  required: ['method', ...exportScopeSchema.required],
  properties: {
    ...exportScopeSchema.properties,
    method: { const: 'exports.build' },
  },
} as const
export type ExportBuildRequest = FromSchema<typeof exportBuildRequestSchema>
export interface ExportReceipt {
  cancelled: boolean
  taskCount?: number
  referenceCount?: number
  bytes?: number
}

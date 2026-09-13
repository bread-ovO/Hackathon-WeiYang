import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const version = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
const cursor = { type: 'string', maxLength: 65536 } as const
const grant = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'domain'],
      properties: {
        kind: { const: 'http-json' },
        domain: {
          type: 'string',
          minLength: 1,
          maxLength: 253,
          pattern:
            '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$',
        },
        credentialId: id,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'path'],
      properties: {
        kind: { const: 'local-jsonl' },
        path: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          pattern: '^(?:/|[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\u0000]+$',
        },
      },
    },
  ],
} as const
/** The event schema is supplied by the barrel to avoid a runtime import cycle. */
export function createPluginHostRequestSchema(
  event: typeof import('./index').sourceEventSchema,
) {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['method'],
        properties: { method: { const: 'pluginHost.list' } },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: { method: { const: 'pluginHost.get' }, id },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'input'],
        properties: {
          method: { const: 'pluginHost.activate' },
          input: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'projectId',
              'displayName',
              'version',
              'digest',
              'manifest',
              'grant',
            ],
            properties: {
              id,
              projectId: { ...id, maxLength: 256 },
              displayName: { type: 'string', minLength: 1, maxLength: 80 },
              version: { type: 'string', minLength: 1, maxLength: 128 },
              digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              manifest: { type: 'object', maxProperties: 64 },
              grant,
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: { method: { const: 'pluginHost.disable' }, id },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: { method: { const: 'pluginHost.uninstall' }, id },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'input'],
        properties: {
          method: { const: 'pluginHost.receiveBatch' },
          input: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'grantVersion',
              'expectedCursor',
              'cursor',
              'events',
            ],
            properties: {
              id,
              grantVersion: version,
              expectedCursor: cursor,
              cursor,
              events: { type: 'array', maxItems: 500, items: event },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id', 'grantVersion'],
        properties: {
          method: { const: 'pluginHost.recordError' },
          id,
          grantVersion: version,
        },
      },
    ],
  } as const
}
export type PluginHostRequest = FromSchema<
  ReturnType<typeof createPluginHostRequestSchema>
>

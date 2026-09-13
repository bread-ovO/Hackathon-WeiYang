import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const uuid = {
  type: 'string',
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
} as const
const owner = {
  type: 'string',
  minLength: 1,
  maxLength: 39,
  pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$',
} as const
const repo = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  pattern: '^(?!\\.{1,2}$)[A-Za-z0-9_.-]+$',
} as const
const positive = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
const timestamp = {
  type: 'integer',
  minimum: 0,
  maximum: 8640000000000000,
} as const
const recordCursor = { type: 'string', minLength: 1, maxLength: 4096 } as const
const collectorCursor = { type: 'string', maxLength: 65536 } as const
const selection = { projectId: id, owner, repo, credentialId: uuid } as const
export const githubErrorCodes = [
  'GITHUB_REQUEST_FAILED',
  'GITHUB_RATE_LIMITED',
  'GITHUB_AUTH_FAILED',
  'GITHUB_REPOSITORY_CHANGED',
  'GITHUB_INVALID_RESPONSE',
  'GITHUB_CREDENTIAL_UNAVAILABLE',
  'INGESTION_QUEUE_LIMIT',
  'INGESTION_DATABASE_LIMIT',
  'INGESTION_DISK_LOW',
  'INGESTION_PROBE_UNAVAILABLE',
] as const
export type GithubConnectionError = (typeof githubErrorCodes)[number]
export const githubRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'github.list' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'owner', 'repo', 'credentialId'],
      properties: { method: { const: 'github.connect' }, ...selection },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id', 'enabled'],
      properties: {
        method: { const: 'github.setEnabled' },
        id: uuid,
        enabled: { type: 'boolean' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'github.revoke' }, id: uuid },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: { method: { const: 'github.sync' }, id: uuid },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'id'],
      properties: {
        method: { const: 'github.records' },
        id: uuid,
        cursor: recordCursor,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  ],
} as const
export type GithubRequest = FromSchema<typeof githubRequestSchema>
export function createGithubHostRequestSchema(
  event: typeof import('./index').sourceEventSchema,
) {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['method'],
        properties: { method: { const: 'githubHost.list' } },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: { method: { const: 'githubHost.get' }, id: uuid },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'credentialId'],
        properties: {
          method: { const: 'githubHost.getCooldown' },
          credentialId: uuid,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'credentialId', 'notBefore'],
        properties: {
          method: { const: 'githubHost.recordCooldown' },
          credentialId: uuid,
          notBefore: timestamp,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'input'],
        properties: {
          method: { const: 'githubHost.authorize' },
          input: {
            type: 'object',
            additionalProperties: false,
            required: [
              'projectId',
              'owner',
              'repo',
              'repositoryId',
              'credentialId',
            ],
            properties: { ...selection, repositoryId: positive },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id', 'enabled'],
        properties: {
          method: { const: 'githubHost.setEnabled' },
          id: uuid,
          enabled: { type: 'boolean' },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: { method: { const: 'githubHost.revoke' }, id: uuid },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'method',
          'id',
          'expectedGrantVersion',
          'expectedPollVersion',
          'expectedCursor',
          'events',
          'nextCursor',
          'nextPollAt',
        ],
        properties: {
          method: { const: 'githubHost.receiveBatch' },
          id: uuid,
          expectedGrantVersion: positive,
          expectedPollVersion: positive,
          expectedCursor: collectorCursor,
          events: { type: 'array', maxItems: 100, items: event },
          nextCursor: collectorCursor,
          nextPollAt: timestamp,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: [
          'method',
          'id',
          'expectedGrantVersion',
          'expectedPollVersion',
          'expectedCursor',
          'errorCode',
          'nextPollAt',
        ],
        properties: {
          method: { const: 'githubHost.recordFailure' },
          id: uuid,
          expectedGrantVersion: positive,
          expectedPollVersion: positive,
          expectedCursor: collectorCursor,
          errorCode: { enum: githubErrorCodes },
          nextPollAt: timestamp,
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['method', 'id'],
        properties: {
          method: { const: 'githubHost.records' },
          id: uuid,
          cursor: recordCursor,
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    ],
  } as const
}
export type GithubHostRequest = FromSchema<
  ReturnType<typeof createGithubHostRequestSchema>
>
export interface GithubConnection {
  id: string
  projectId: string
  owner: string
  repo: string
  repositoryId: number
  credentialId: string
  grantVersion: number
  status: 'active' | 'paused' | 'revoked' | 'error'
  nextPollAt: number
  lastSuccessAt: string | null
  errorCode: GithubConnectionError | null
  failureCount: number
  eventCount: number
}
export interface GithubAuthorized extends GithubConnection {
  pollVersion: number
  cursor: string
  enabled: boolean
  revoked: boolean
}
export interface GithubSnapshot {
  connections: GithubConnection[]
}
export interface GithubRecords {
  records: {
    id: number
    externalId: string
    revision: string
    occurredAt: string
    receivedAt: string
    text: string
    role: 'tool'
  }[]
  nextCursor: string | null
}

export interface GithubCooldown {
  notBefore: number
  failureCount: number
}

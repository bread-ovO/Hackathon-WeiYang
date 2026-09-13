import type { FromSchema } from 'json-schema-to-ts'
import { ajv, idSchema, nullableDateSchema } from './validation'
const version = { type: 'integer', minimum: 0 } as const
const eventId = { type: 'integer', minimum: 1 } as const
const title = { type: 'string', minLength: 1, maxLength: 1000 } as const
export const taskCommandSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'title', 'projectId', 'sourceId', 'scopeId'],
      properties: {
        kind: { const: 'create' },
        taskId: idSchema,
        title,
        projectId: idSchema,
        sourceId: idSchema,
        scopeId: idSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'status'],
      properties: {
        kind: { const: 'set_status' },
        taskId: idSchema,
        status: {
          enum: ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'title'],
      properties: { kind: { const: 'set_title' }, taskId: idSchema, title },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'intake'],
      properties: {
        kind: { const: 'set_intake' },
        taskId: idSchema,
        intake: { enum: ['candidate', 'accepted', 'ignored'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'archivedAt'],
      properties: {
        kind: { const: 'archive' },
        taskId: idSchema,
        archivedAt: nullableDateSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'sourceId', 'scopeId'],
      properties: {
        kind: { const: 'link_source' },
        taskId: idSchema,
        sourceId: idSchema,
        scopeId: idSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'field'],
      properties: {
        kind: { const: 'release_override' },
        taskId: idSchema,
        field: {
          enum: [
            'title',
            'status',
            'intake',
            'criteria',
            'evidence',
            'archive',
            'due',
          ],
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'dueAt', 'effectiveAt', 'originEventId'],
      properties: {
        kind: { const: 'set_due' },
        taskId: idSchema,
        dueAt: nullableDateSchema,
        effectiveAt: { type: 'string', format: 'date-time' },
        originEventId: { anyOf: [eventId, { type: 'null' }] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'criteria'],
      properties: {
        kind: { const: 'set_criteria' },
        taskId: idSchema,
        criteria: {
          type: 'array',
          maxItems: 32,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'description', 'originEventId'],
            properties: {
              id: idSchema,
              description: title,
              originEventId: { anyOf: [eventId, { type: 'null' }] },
            },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'taskId', 'links'],
      properties: {
        kind: { const: 'add_evidence' },
        taskId: idSchema,
        links: {
          type: 'array',
          minItems: 1,
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'criterionId',
              'criteriaVersion',
              'eventId',
              'relation',
              'start',
              'end',
            ],
            properties: {
              criterionId: idSchema,
              criteriaVersion: { type: 'integer', minimum: 1 },
              eventId,
              relation: { enum: ['support', 'oppose', 'related'] },
              start: version,
              end: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
  ],
} as const
export type TaskCommand = FromSchema<typeof taskCommandSchema>
export const proposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'commands',
    'expected',
    'inputs',
    'mappings',
    'reason',
    'policyVersion',
  ],
  properties: {
    commands: { type: 'array', maxItems: 16, items: taskCommandSchema },
    expected: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId', 'version', 'criteriaVersion', 'manualVersion'],
        properties: {
          taskId: idSchema,
          version,
          criteriaVersion: version,
          manualVersion: version,
        },
      },
    },
    inputs: {
      type: 'array',
      maxItems: 128,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['eventId', 'generation', 'scopeEpoch'],
        properties: {
          eventId,
          generation: { type: 'integer', minimum: 1 },
          scopeEpoch: { type: 'integer', minimum: 1 },
        },
      },
    },
    mappings: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'version'],
        properties: { id: idSchema, version: { type: 'integer', minimum: 1 } },
      },
    },
    reason: { type: 'string', minLength: 1, maxLength: 2000 },
    policyVersion: idSchema,
  },
} as const
export type DecisionProposal = FromSchema<typeof proposalSchema>
const validate = ajv.compile<DecisionProposal>(proposalSchema)
export function parseProposal(input: unknown): DecisionProposal {
  if (!validate(input)) throw new Error('INVALID_PROPOSAL')
  return input
}
export interface Lease {
  id: number
  owner: string
  token: number
  until: number
  operationId: string
  eventId: number
  sourceId: string
  scopeEpoch: number
  attempt: number
  pipelineVersion: string
}
export interface OperationResult {
  operationId: string
  taskIds: string[]
  changed: boolean
}

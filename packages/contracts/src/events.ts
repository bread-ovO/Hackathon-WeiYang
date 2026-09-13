import type { FromSchema } from 'json-schema-to-ts'
import {
  ajv,
  idSchema,
  dateSchema,
  nullableDateSchema,
  nullableIdSchema,
} from './validation'

export const sourceEventSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'sourceInstanceId',
    'externalId',
    'revision',
    'occurredAt',
    'role',
    'text',
  ],
  properties: {
    schemaVersion: { const: 1 },
    sourceInstanceId: idSchema,
    externalId: idSchema,
    revision: idSchema,
    occurredAt: dateSchema,
    role: { enum: ['user', 'assistant', 'tool', 'system'] },
    text: { type: 'string', maxLength: 65536 },
  },
} as const
export type SourceEvent = FromSchema<typeof sourceEventSchema>
export const validateSourceEvent = ajv.compile<SourceEvent>(sourceEventSchema)
export function parseSourceEvent(input: unknown): SourceEvent {
  if (!validateSourceEvent(input)) throw new Error('INVALID_SOURCE_EVENT')
  return input
}
const payloadSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'role', 'text'],
      properties: {
        kind: { const: 'message' },
        role: { enum: ['user', 'assistant', 'tool', 'system'] },
        text: { type: 'string', maxLength: 65536 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'objectKind', 'objectId', 'text'],
      properties: {
        kind: { const: 'delivery' },
        objectKind: {
          enum: ['pull_request', 'check', 'deployment', 'document'],
        },
        objectId: idSchema,
        text: { type: 'string', maxLength: 65536 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'tombstone' } },
    },
  ],
} as const
export const sourceEventV2Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'sourceInstanceId',
    'externalId',
    'revision',
    'eventType',
    'occurredAt',
    'sourceUpdatedAt',
    'timeBasis',
    'payload',
    'provenance',
  ],
  properties: {
    schemaVersion: { const: 2 },
    sourceInstanceId: idSchema,
    externalId: idSchema,
    revision: idSchema,
    eventType: {
      enum: ['created', 'updated', 'retracted', 'deleted', 'observed'],
    },
    occurredAt: nullableDateSchema,
    sourceUpdatedAt: nullableDateSchema,
    timeBasis: {
      type: 'object',
      additionalProperties: false,
      required: ['raw', 'timeZone', 'kind'],
      properties: {
        raw: { anyOf: [{ type: 'string', maxLength: 256 }, { type: 'null' }] },
        timeZone: nullableIdSchema,
        kind: { enum: ['explicit_offset', 'source_zone', 'unknown'] },
      },
    },
    payload: payloadSchema,
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: [
        'adapterId',
        'adapterVersion',
        'scopeId',
        'accountId',
        'tenantId',
        'resourceId',
        'author',
        'revisionBasis',
        'sequence',
        'supersedesRevision',
        'coverage',
      ],
      properties: {
        adapterId: idSchema,
        adapterVersion: idSchema,
        scopeId: idSchema,
        accountId: idSchema,
        tenantId: nullableIdSchema,
        resourceId: idSchema,
        author: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['namespace', 'id'],
              properties: { namespace: idSchema, id: idSchema },
            },
          ],
        },
        revisionBasis: {
          enum: [
            'sequence',
            'predecessor',
            'source_time',
            'opaque',
            'snapshot',
            'legacy',
          ],
        },
        sequence: {
          anyOf: [
            { type: 'integer', minimum: 0, maximum: 9007199254740991 },
            { type: 'null' },
          ],
        },
        supersedesRevision: nullableIdSchema,
        coverage: { enum: ['revisioned', 'snapshot_only', 'legacy'] },
      },
    },
  },
} as const
export type SourceEventV2 = FromSchema<typeof sourceEventV2Schema>
const validateV2 = ajv.compile<SourceEventV2>(sourceEventV2Schema)
export function parseEventV2(input: unknown): SourceEventV2 {
  if (!validateV2(input)) throw new Error('INVALID_SOURCE_EVENT')
  const p = input.provenance
  if (
    (input.eventType === 'retracted' || input.eventType === 'deleted') !==
      (input.payload.kind === 'tombstone') ||
    (input.occurredAt === null) !== (input.timeBasis.kind === 'unknown')
  )
    throw new Error('INVALID_SOURCE_EVENT')
  if (
    (p.revisionBasis === 'sequence') !== (p.sequence !== null) ||
    (p.revisionBasis === 'source_time' && input.sourceUpdatedAt === null)
  )
    throw new Error('INVALID_REVISION_BASIS')
  if (
    (p.revisionBasis === 'snapshot' || p.revisionBasis === 'legacy') &&
    (input.eventType !== 'observed' || p.coverage === 'revisioned')
  )
    throw new Error('INVALID_REVISION_BASIS')
  if (p.supersedesRevision === input.revision)
    throw new Error('INVALID_REVISION_BASIS')
  if (input.timeBasis.timeZone !== null) {
    try {
      new Intl.DateTimeFormat('en', {
        timeZone: input.timeBasis.timeZone,
      }).format(0)
    } catch {
      throw new Error('INVALID_TIME_ZONE')
    }
  }
  return input
}
export function upgradeLegacy(input: SourceEvent): SourceEventV2 {
  return parseEventV2({
    schemaVersion: 2,
    sourceInstanceId: input.sourceInstanceId,
    externalId: input.externalId,
    revision: input.revision,
    eventType: 'observed',
    occurredAt: input.occurredAt,
    sourceUpdatedAt: null,
    timeBasis: {
      raw: input.occurredAt,
      timeZone: null,
      kind: 'explicit_offset',
    },
    payload: { kind: 'message', role: input.role, text: input.text },
    provenance: {
      adapterId: 'legacy',
      adapterVersion: '1',
      scopeId: 'legacy',
      accountId: 'legacy',
      tenantId: null,
      resourceId: input.externalId,
      author: null,
      revisionBasis: 'legacy',
      sequence: null,
      supersedesRevision: null,
      coverage: 'legacy',
    },
  })
}
export const sourcePageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceInstanceId',
    'streamId',
    'scopeEpoch',
    'batchId',
    'expectedCursorVersion',
    'nextCursor',
    'events',
  ],
  properties: {
    sourceInstanceId: idSchema,
    streamId: idSchema,
    scopeEpoch: { type: 'integer', minimum: 1 },
    batchId: idSchema,
    expectedCursorVersion: { type: 'integer', minimum: 0 },
    nextCursor: { type: 'string', maxLength: 4096 },
    events: { type: 'array', maxItems: 1000, items: sourceEventV2Schema },
  },
} as const
export type SourcePage = FromSchema<typeof sourcePageSchema>
const validatePage = ajv.compile<SourcePage>(sourcePageSchema)
export function parseSourcePage(input: unknown): SourcePage {
  if (!validatePage(input)) throw new Error('INVALID_SOURCE_PAGE')
  input.events.forEach(parseEventV2)
  return input
}
export interface IngestionContext {
  sourceInstanceId: string
  scopeEpoch: number
}
export interface Checkpoint {
  cursor: string
  version: number
  scopeEpoch: number
}
export interface Receipt {
  batchId: string
  inserted: number
  duplicates: number
  committedVersion: number
  committedAt: string
  checkpoint: Checkpoint
}
export function eventText(event: SourceEventV2): string {
  return event.payload.kind === 'tombstone' ? '' : event.payload.text
}
export function sourceSlice(
  event: SourceEventV2,
  start: number,
  end: number,
): string {
  const points = Array.from(eventText(event))
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > points.length
  )
    throw new Error('INVALID_SPAN')
  return points.slice(start, end).join('')
}

// Dispatch old stored/imported inputs explicitly; unknown versions cannot become legacy.
export function parseVersionedEvent(input: unknown): SourceEventV2 {
  if (!input || typeof input !== 'object' || !('schemaVersion' in input)) throw new Error('INVALID_SOURCE_EVENT')
  if (input.schemaVersion === 1) return upgradeLegacy(parseSourceEvent(input))
  if (input.schemaVersion === 2) return parseEventV2(input)
  throw new Error('UNSUPPORTED_EVENT_VERSION')
}

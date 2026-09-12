import {
  workspaceRequestSchema,
  type WorkspaceSnapshot,
  type WorkspaceQuery,
  type WorkspaceDetail,
} from './workspace'
export * from './workspace'
import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

// JSON Schema is the runtime boundary; TypeScript types are derived from it.
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
    sourceInstanceId: { type: 'string', minLength: 1, maxLength: 128 },
    externalId: { type: 'string', minLength: 1, maxLength: 256 },
    revision: { type: 'string', minLength: 1, maxLength: 128 },
    occurredAt: { type: 'string', format: 'date-time' },
    role: { enum: ['user', 'assistant', 'tool', 'system'] },
    text: { type: 'string', maxLength: 65536 },
  },
} as const
export type SourceEvent = FromSchema<typeof sourceEventSchema>
const ajv = new Ajv({ allErrors: true })
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value: string) => {
    const m =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
        value,
      )
    if (!m || !Number.isFinite(Date.parse(value))) return false
    const year = Number(m[1]),
      month = Number(m[2]),
      day = Number(m[3])
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= days[month - 1]! &&
      Number(m[4]) < 24 &&
      Number(m[5]) < 60 &&
      Number(m[6]) < 60
    )
  },
})
// Desktop dates are canonical UTC input; reject calendar rollover and ambiguous local dates.
ajv.addFormat('workspace-date-time', {
  type: 'string',
  validate: (value: string) => {
    const m =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
        value,
      )
    if (
      !m ||
      Number(m[1]) < 1 ||
      Number(m[4]) > 23 ||
      Number(m[5]) > 59 ||
      Number(m[6]) > 59
    )
      return false
    const time = Date.parse(value)
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 19) === value.slice(0, 19)
    )
  },
})
export const validateSourceEvent = ajv.compile<SourceEvent>(sourceEventSchema)
export function parseSourceEvent(value: unknown): SourceEvent {
  if (!validateSourceEvent(value)) throw new Error('INVALID_SOURCE_EVENT')
  return value
}
export const healthRequestSchema = {
  type: 'object',
  properties: { method: { const: 'health' } },
  required: ['method'],
  additionalProperties: false,
} as const
const coreRequestSchema = {
  oneOf: [healthRequestSchema, workspaceRequestSchema],
} as const
export type CoreRequest = FromSchema<typeof coreRequestSchema>
const validateRequest = ajv.compile<CoreRequest>(coreRequestSchema)
export function parseCoreRequest(value: unknown): CoreRequest {
  if (!validateRequest(value)) throw new Error('INVALID_REQUEST')
  if (
    value.method === 'workspace.replaceCriteria' &&
    (new Set(value.criteria.map((c) => c.id)).size !== value.criteria.length ||
      value.criteria.reduce((sum, c) => sum + c.description.length + 1, 0) >
        16384)
  )
    throw new Error('INVALID_REQUEST')
  return value
}
export interface Health {
  status: 'ready'
  schemaVersion: number
  sqliteVersion: string
  eventCount: number
  jobCount: number
}
export type CoreReply<T = Health> =
  | { ok: true; data: T }
  | {
      ok: false
      error:
        | 'CORE_UNAVAILABLE'
        | 'INVALID_REQUEST'
        | 'INTERNAL_ERROR'
        | 'VERSION_CONFLICT'
        | 'NOT_FOUND'
    }
export interface DesktopBridge {
  health(): Promise<CoreReply>
  workspace: {
    list(query?: WorkspaceQuery): Promise<CoreReply<WorkspaceSnapshot>>
    detail(
      projectId: string,
      id: string,
      criteriaVersion?: number,
    ): Promise<CoreReply<WorkspaceDetail>>
    replaceCriteria(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.replaceCriteria' }>,
        'method'
      >,
    ): Promise<CoreReply<WorkspaceSnapshot>>
    createProject(name: string): Promise<CoreReply<WorkspaceSnapshot>>
    createTask(
      projectId: string,
      title: string,
    ): Promise<CoreReply<WorkspaceSnapshot>>
    updateTask(
      request: Omit<
        Extract<CoreRequest, { method: 'workspace.updateTask' }>,
        'method'
      >,
    ): Promise<CoreReply<WorkspaceSnapshot>>
  }
}

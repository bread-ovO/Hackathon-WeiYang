import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

// JSON Schema is the runtime boundary; TypeScript types are derived from it.
export const sourceEventSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion','sourceInstanceId','externalId','revision','occurredAt','role','text'],
  properties: {
    schemaVersion: { const: 1 }, sourceInstanceId: { type:'string', minLength:1, maxLength:128 },
    externalId: { type:'string', minLength:1, maxLength:256 }, revision: { type:'string', minLength:1, maxLength:128 },
    occurredAt: { type:'string', format:'date-time' },
    role: { enum:['user','assistant','tool','system'] }, text: { type:'string', maxLength:65536 }
  }
} as const
export type SourceEvent = FromSchema<typeof sourceEventSchema>
const ajv = new Ajv({ allErrors: true })
ajv.addFormat('date-time', { type:'string', validate: (value: string) => {
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!m || !Number.isFinite(Date.parse(value))) return false
  const year=Number(m[1]), month=Number(m[2]), day=Number(m[3])
  const leap=year%4===0 && (year%100!==0 || year%400===0)
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31]
  return month>=1 && month<=12 && day>=1 && day<=days[month-1]! && Number(m[4])<24 && Number(m[5])<60 && Number(m[6])<60
} })
export const validateSourceEvent = ajv.compile<SourceEvent>(sourceEventSchema)
export function parseSourceEvent(value: unknown): SourceEvent {
  if (!validateSourceEvent(value)) throw new Error('INVALID_SOURCE_EVENT')
  return value
}
export const healthRequestSchema = { type:'object', properties: { method: { const:'health' } }, required:['method'], additionalProperties:false } as const
export type CoreRequest = FromSchema<typeof healthRequestSchema>
const validateRequest = ajv.compile<CoreRequest>(healthRequestSchema)
export function parseCoreRequest(value: unknown): CoreRequest {
  if (!validateRequest(value)) throw new Error('INVALID_REQUEST')
  return value
}
export interface Health {
  status: 'ready'; schemaVersion: number; sqliteVersion: string; eventCount: number; jobCount: number
}
export type CoreReply = { ok:true; data:Health } | { ok:false; error:'CORE_UNAVAILABLE'|'INVALID_REQUEST'|'INTERNAL_ERROR' }
export interface DesktopBridge { health(): Promise<CoreReply> }

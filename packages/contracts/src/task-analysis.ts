import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

export interface AnalysisMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  occurredAt?: string
}
export const TASK_ANALYSIS_PROTOCOL = 'task-analysis-v3'
export const analysisRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'sourceId'],
      properties: {
        method: { const: 'analysis.start' },
        sourceId: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method'],
      properties: { method: { const: 'analysis.status' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'runId', 'index'],
      properties: {
        method: { const: 'analysis.accept' },
        runId: { type: 'string', minLength: 1, maxLength: 128 },
        index: { type: 'integer', minimum: 0, maximum: 11 },
      },
    },
  ],
} as const
export type AnalysisRequest = FromSchema<typeof analysisRequestSchema>
export interface AnalysisSnapshot {
  state: 'idle' | 'running' | 'ready' | 'error'
  error: string | null
  runId: string | null
  sourceId: string | null
  model: string
  messageCount: number
  truncated: boolean
  result: TaskAnalysis | null
  accepted: number[]
}
export const taskAnalysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'stage', 'nextAction', 'evidence'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 240 },
          stage: {
            type: 'string',
            enum: [
              'requested',
              'in_progress',
              'delivered',
              'accepted',
              'cancelled',
            ],
          },
          nextAction: { type: 'string', maxLength: 500 },
          existingTaskId: {
            type: ['string', 'null'],
            minLength: 1,
            maxLength: 128,
          },
          deadline: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['dueAt', 'messageId', 'quote'],
                properties: {
                  dueAt: { type: 'string', minLength: 20, maxLength: 24 },
                  messageId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 128,
                  },
                  quote: { type: 'string', minLength: 1, maxLength: 2000 },
                },
              },
            ],
          },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['messageId', 'quote'],
              properties: {
                messageId: { type: 'string', minLength: 1, maxLength: 128 },
                quote: { type: 'string', minLength: 1, maxLength: 2000 },
              },
            },
          },
        },
      },
    },
  },
} as const
export type TaskAnalysis = FromSchema<typeof taskAnalysisSchema>
export interface KnownAnalysisTask {
  id: string
  title: string
  stage: TaskAnalysis['tasks'][number]['stage']
  nextAction: string
  evidence: TaskAnalysis['tasks'][number]['evidence']
}
// The storage schema accepts historical proposals without an identity field.
// Live providers receive a strict shape with every property required.
export const taskExtractionSchema = {
  ...taskAnalysisSchema,
  properties: {
    tasks: {
      ...taskAnalysisSchema.properties.tasks,
      items: {
        ...taskAnalysisSchema.properties.tasks.items,
        required: [
          ...taskAnalysisSchema.properties.tasks.items.required,
          'existingTaskId',
          'deadline',
        ],
      },
    },
  },
} as const
const validate = new Ajv({ strict: true }).compile<TaskAnalysis>(
  taskAnalysisSchema,
)
function fail(): never {
  throw new Error('INVALID_TASK_ANALYSIS')
}
export function validateAnalysisMessages(
  messages: AnalysisMessage[],
): void {
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > 64
  )
    fail()
  const ids = new Set<string>()
  let length = 0
  for (const m of messages) {
    if (
      !m ||
      typeof m.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(m.id) ||
      ids.has(m.id) ||
      !['user', 'assistant'].includes(m.role) ||
      typeof m.text !== 'string' ||
      !m.text.length
    )
      fail()
    if (
      m.occurredAt !== undefined &&
      (typeof m.occurredAt !== 'string' ||
        m.occurredAt.length > 40 ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          m.occurredAt,
        ) ||
        !Number.isFinite(Date.parse(m.occurredAt)))
    )
      fail()
    ids.add(m.id)
    length += m.text.length
  }
  if (length > 65536) fail()
}
/** Verifies structure and source quotations, NOT semantic truth. All stages are
 * review suggestions; this function cannot authorize a business-status change. */
export function parseTaskAnalysis(
  value: unknown,
  messages: AnalysisMessage[],
): TaskAnalysis {
  validateAnalysisMessages(messages)
  if (!validate(value)) fail()
  const seen = new Set<string>()
  for (const task of value.tasks) {
    if (
      !task.title.trim() ||
      (!task.nextAction.trim() &&
        !['accepted', 'cancelled'].includes(task.stage))
    )
      fail()
    const refs = new Set<string>()
    const userRefs = new Set<string>()
    for (const e of task.evidence) {
      const m = messages.find((m) => m.id === e.messageId)
      if (!m || !e.quote.trim() || !m.text.includes(e.quote)) fail()
      const key = JSON.stringify([e.messageId, e.quote])
      if (refs.has(key)) fail()
      refs.add(key)
      if (m.role === 'user') userRefs.add(m.id)
    }
    if (!userRefs.size) fail()
    if (task.deadline) {
      const d = task.deadline
      const m = messages.find((m) => m.id === d.messageId)
      // Validate authority and calendar shape; deadline meaning is model work.
      if (
        !m ||
        m.role !== 'user' ||
        !m.occurredAt ||
        !d.quote.trim() ||
        !m.text.includes(d.quote) ||
        !task.evidence.some(
          (e) => e.messageId === d.messageId && e.quote.includes(d.quote),
        ) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
          d.dueAt,
        ) ||
        !Number.isFinite(Date.parse(d.dueAt)) ||
        new Date(d.dueAt).toISOString().slice(0, 19) !==
          d.dueAt.slice(0, 19)
      )
        fail()
    }
    // A separate user turn is required to propose acceptance/cancellation.
    if (['accepted', 'cancelled'].includes(task.stage) && userRefs.size < 2)
      fail()
    // Stage semantics belong to the model and remain review suggestions. A
    // keyword/negation check over a whole quote incorrectly rejects independent
    // goals (one accepted, another unfinished), and cannot prove acceptance.
    const key = JSON.stringify([task.title.trim(), [...refs].sort()])
    if (seen.has(key)) fail()
    seen.add(key)
  }
  return structuredClone(value)
}

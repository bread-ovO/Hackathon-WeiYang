import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'
const text = { type: 'string', maxLength: 4000 } as const
const id = { type: 'string', minLength: 1, maxLength: 256 } as const
const nullableText = {
  anyOf: [{ type: 'string', maxLength: 512 }, { type: 'null' }],
} as const
export const chatActionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'taskId', 'title', 'status', 'dueAt', 'owner'],
  properties: {
    kind: { enum: ['create', 'update', 'delete', 'restore'] },
    taskId: { type: 'string', maxLength: 256 },
    title: nullableText,
    status: {
      anyOf: [
        { enum: ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'] },
        { type: 'null' },
      ],
    },
    dueAt: nullableText,
    owner: nullableText,
  },
} as const
export const taskChatOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'tool', 'query', 'taskId', 'actions'],
  properties: {
    message: text,
    tool: { enum: ['answer', 'search_tasks', 'get_task', 'propose_changes'] },
    query: { type: 'string', maxLength: 256 },
    taskId: { type: 'string', maxLength: 256 },
    actions: { type: 'array', maxItems: 8, items: chatActionSchema },
  },
} as const
export type ChatOutput = FromSchema<typeof taskChatOutputSchema>
export type ChatAction = FromSchema<typeof chatActionSchema>
const validate = new Ajv({ strict: true }).compile<ChatOutput>(
  taskChatOutputSchema,
)
export function parseChatOutput(raw: string): ChatOutput {
  let v: unknown
  try {
    if (raw.length > 65536) throw Error()
    v = JSON.parse(raw)
  } catch {
    throw Error('CHAT_INVALID_OUTPUT')
  }
  if (!validate(v)) throw Error('CHAT_INVALID_OUTPUT')
  if (v.tool !== 'propose_changes' && v.actions.length)
    throw Error('CHAT_INVALID_OUTPUT')
  if (v.tool === 'propose_changes' && !v.actions.length)
    throw Error('CHAT_INVALID_OUTPUT')
  for (const a of v.actions) {
    if (a.kind === 'create' ? !a.title?.trim() || a.taskId !== '' : !a.taskId)
      throw Error('CHAT_INVALID_OUTPUT')
    if (
      a.dueAt !== null &&
      a.dueAt !== '' &&
      (!/^\d{4}-\d\d-\d\dT/.test(a.dueAt) ||
        !Number.isFinite(Date.parse(a.dueAt)))
    )
      throw Error('CHAT_INVALID_OUTPUT')
  }
  return v
}
export const taskChatRequestSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'kind'],
      properties: {
        method: { const: 'chat.draft' },
        projectId: id,
        kind: { enum: ['daily', 'feedback'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId'],
      properties: { method: { const: 'chat.status' }, projectId: id },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'message'],
      properties: {
        method: { const: 'chat.send' },
        projectId: id,
        message: { ...text, minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'runId'],
      properties: {
        method: { const: 'chat.confirm' },
        projectId: id,
        runId: id,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'runId'],
      properties: {
        method: { const: 'chat.cancel' },
        projectId: id,
        runId: id,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'projectId', 'runId'],
      properties: {
        method: { const: 'chat.reject' },
        projectId: id,
        runId: id,
      },
    },
  ],
} as const
export type ChatRequest = FromSchema<typeof taskChatRequestSchema>
export interface ChatTask {
  id: string
  title: string
  status: string
  version: number
  criteriaVersion: number
  manualVersion: number
  dueAt: string | null
  owner: string | null
  deleted: boolean
}
export interface ChatRun {
  id: string
  projectId: string
  prompt: string
  state: 'running' | 'ready' | 'applied' | 'failed' | 'cancelled' | 'rejected'
  reply: string
  actions: ChatAction[]
  tasks: ChatTask[]
  trace: string[]
  error: string | null
  model: string
  createdAt: string
  draft?: ChatDraft
}
export interface ChatSnapshot {
  runs: ChatRun[]
}

export interface ChatDraft {
  kind: 'daily' | 'feedback'
  body: string
  generatedAt: string
  truncated: boolean
  references: {
    label: string
    taskId: string
    version: number
    quote: string
  }[]
}

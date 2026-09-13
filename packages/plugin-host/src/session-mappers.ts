/**
 * Pure record normalizers for the built-in coding-agent session sources
 * (Claude Code / Codex local JSONL session files). Each mapper decides whether
 * a parsed JSONL line is a conversational record worth keeping and rewrites it
 * into the built-in local-jsonl shape {id, revision, created_at, role, content}.
 * Returning null skips the line. No I/O, no platform dependencies.
 */

export interface NormalizedSessionRecord {
  id: string
  revision: string
  created_at: string
  role: 'user' | 'assistant'
  content: string
}
export type SessionMapper = (
  record: Record<string, unknown>,
  context?: { byteOffset: number },
) => NormalizedSessionRecord | null

/** Reject oversize text rather than changing the original quoted message. */
const TEXT_LIMIT = 65536

const ownObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.includes('T') &&
    Number.isFinite(Date.parse(value))
  )
}

function finish(
  id: string,
  timestamp: string,
  role: 'user' | 'assistant',
  text: string,
): NormalizedSessionRecord | null {
  if (!id || id.length > 256 || text.length > TEXT_LIMIT) invalid()
  if (!text.trim()) return null
  return {
    id,
    revision: '1',
    created_at: timestamp,
    role,
    content: text,
  }
}

function invalid(): never {
  throw new Error('UNSUPPORTED_SESSION_FORMAT')
}
const ignoredBlocks = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result',
  'image',
  'document',
  'input_image',
  'input_audio',
  'output_audio',
  'image_url',
  'audio_url',
  'video_url',
  'refusal',
])
function blockTexts(blocks: unknown, types: ReadonlySet<string>): string {
  if (!Array.isArray(blocks)) return invalid()
  const parts: string[] = []
  for (const block of blocks) {
    if (!ownObject(block) || typeof block.type !== 'string') invalid()
    if (types.has(block.type)) {
      if (typeof block.text !== 'string') invalid()
      parts.push(block.text)
    } else if (!ignoredBlocks.has(block.type)) invalid()
  }
  return parts.join('\n\n')
}
const claudeMetadata = new Set([
  'permission-mode',
  'file-history-snapshot',
  'attachment',
  'queue-operation',
  'system',
  'summary',
  'progress',
  'last-prompt',
  'custom-title',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
])
const codexMetadata = new Set([
  'session_meta',
  'event_msg',
  'turn_context',
  'compacted',
  'token_usage_record',
  'world_state',
  'retained_context',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'realtime_item',
  'extension_item',
])
const codexNonMessages = new Set([
  'reasoning',
  'function_call',
  'function_call_output',
  'web_search_call',
  'custom_tool_call',
  'custom_tool_call_output',
  'local_shell_call',
  'image_generation_call',
  'ghost_snapshot',
  'compaction',
  'other',
  'token_count',
  'task_started',
  'task_complete',
  'item_completed',
])

const claudeRoles = new Set(['user', 'assistant'])
const claudeTextBlocks = new Set(['text'])

/** Claude Code session line: keep type user/assistant with a message object;
 * skip known metadata only; malformed messages and unknown record types fail. Content arrays keep only
 * text blocks (thinking/tool_use/tool_result blocks are dropped). */
export const claudeSessionMapper: SessionMapper = (record) => {
  if (typeof record.type !== 'string') invalid()
  if (claudeMetadata.has(record.type)) return null
  if (!claudeRoles.has(record.type)) invalid()
  if (typeof record.uuid !== 'string' || !isoTimestamp(record.timestamp))
    invalid()
  if (!ownObject(record.message)) invalid()
  const role = record.message.role
  if (typeof role !== 'string' || role !== record.type) invalid()
  // String content is used directly; block arrays keep text blocks only.
  const text =
    typeof record.message.content === 'string'
      ? record.message.content
      : blockTexts(record.message.content, claudeTextBlocks)
  return finish(
    record.uuid,
    record.timestamp,
    role as 'user' | 'assistant',
    text,
  )
}

const codexTextBlocks = {
  user: 'input_text',
  assistant: 'output_text',
} as const

/** Codex rollout line: keep type response_item with payload.type message and
 * payload.role user/assistant; skip session_meta, event_msg, turn_context and
 * reasoning/function_call/web_search_call/token_count/task_* payload items as
 * well as developer messages. Ordinals or trusted byte offsets identify rows. */
export const codexSessionMapper: SessionMapper = (record, context) => {
  if (typeof record.type !== 'string') invalid()
  if (codexMetadata.has(record.type)) return null
  if (record.type !== 'response_item') invalid()
  if (!isoTimestamp(record.timestamp) || !ownObject(record.payload)) invalid()
  if (typeof record.payload.type !== 'string') invalid()
  if (codexNonMessages.has(record.payload.type)) return null
  if (record.payload.type !== 'message') invalid()
  const role = record.payload.role
  if (role === 'developer' || role === 'system') return null
  if (role !== 'user' && role !== 'assistant') invalid()
  // Keep v1 ordinal IDs so upgrading does not duplicate previously imported events.
  // Older rollout files have no ordinal. The reader supplies a trusted byte offset,
  // stable across batches/restarts for an append-only file (never text-supplied).
  const ordinal = record.ordinal
  let id: string
  if (ordinal !== undefined && ordinal !== null) {
    if (
      typeof ordinal !== 'number' ||
      !Number.isSafeInteger(ordinal) ||
      ordinal < 0
    )
      invalid()
    id = String(ordinal)
  } else {
    if (
      !context ||
      !Number.isSafeInteger(context.byteOffset) ||
      context.byteOffset < 0
    )
      invalid()
    id = `offset:${context.byteOffset}`
  }
  const text = blockTexts(
    record.payload.content,
    new Set([codexTextBlocks[role]]),
  )
  return finish(id, record.timestamp as string, role, text)
}

/** Kimi Wire logs carry actual occurrence time; context.jsonl does not. */
const kimiIgnored = new Set([
  'TurnEnd',
  'StepBegin',
  'StepInterrupted',
  'StepRetry',
  'CompactionBegin',
  'CompactionEnd',
  'MCPLoadingBegin',
  'MCPLoadingEnd',
  'StatusUpdate',
  'Notification',
  'ThinkPart',
  'ImageURLPart',
  'AudioURLPart',
  'VideoURLPart',
  'ToolCall',
  'ToolCallPart',
  'ToolResult',
  'ApprovalRequest',
  'ApprovalResponse',
  'ApprovalRequestResolved',
  'ToolCallRequest',
  'QuestionRequest',
  'QuestionResponse',
  'HookRequest',
  'HookTriggered',
  'HookResolved',
  'SubagentEvent',
  'PlanDisplay',
  'BtwBegin',
  'BtwEnd',
])
export const kimiSessionMapper: SessionMapper = (record, context) => {
  if (record.type === 'metadata') {
    if (
      typeof record.protocol_version !== 'string' ||
      !/^1\.(?:[1-9]|10)$/.test(record.protocol_version)
    )
      invalid()
    return null
  }
  if (!ownObject(record.message) || !ownObject(record.message.payload))
    invalid()
  const { type, payload } = record.message
  if (typeof type !== 'string') invalid()
  if (kimiIgnored.has(type)) return null
  if (!['TurnBegin', 'SteerInput', 'TextPart'].includes(type)) invalid()
  if (
    typeof record.timestamp !== 'number' ||
    !Number.isFinite(record.timestamp) ||
    record.timestamp < 0 ||
    record.timestamp > 8640000000000
  )
    invalid()
  if (
    !context ||
    !Number.isSafeInteger(context.byteOffset) ||
    context.byteOffset < 0
  )
    invalid()
  const user = type !== 'TextPart'
  const value = user ? payload.user_input : payload.text
  const text =
    typeof value === 'string'
      ? value
      : user
        ? blockTexts(value, new Set(['text']))
        : invalid()
  return finish(
    `offset:${context.byteOffset}`,
    new Date(record.timestamp * 1000).toISOString(),
    user ? 'user' : 'assistant',
    text,
  )
}

/** Stable normalizer identities mixed into the read cursor's mapping
 * fingerprint; bump the suffix when a mapper's keep/extract rules change so
 * existing sources rescan instead of resuming with stale rules. */
export const SESSION_NORMALIZER_IDS = {
  'claude-code': 'claude-code-session@2',
  codex: 'codex-session@2',
  kimi: 'kimi-wire-session@1',
} as const
export type SessionSourceKind = keyof typeof SESSION_NORMALIZER_IDS
export const SESSION_MAPPERS: Record<SessionSourceKind, SessionMapper> = {
  'claude-code': claudeSessionMapper,
  codex: codexSessionMapper,
  kimi: kimiSessionMapper,
}

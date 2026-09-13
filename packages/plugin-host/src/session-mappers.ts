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
) => NormalizedSessionRecord | null

/** Matches the source event schema text budget; deterministic truncation keeps
 * revision "1" stable for append-only session files. */
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
  if (!id || !text.trim()) return null
  return {
    id: id.slice(0, 256),
    revision: '1',
    created_at: timestamp,
    role,
    content: text.slice(0, TEXT_LIMIT),
  }
}

function blockTexts(blocks: unknown, types: ReadonlySet<string>): string | null {
  if (!Array.isArray(blocks)) return null
  const parts: string[] = []
  for (const block of blocks) {
    if (!ownObject(block)) continue
    if (
      typeof block.type === 'string' &&
      types.has(block.type) &&
      typeof block.text === 'string'
    )
      parts.push(block.text)
  }
  return parts.join('\n\n')
}

const claudeRoles = new Set(['user', 'assistant'])
const claudeTextBlocks = new Set(['text'])

/** Claude Code session line: keep type user/assistant with a message object;
 * skip permission-mode, file-history-snapshot, attachment, queue-operation,
 * system and any line lacking uuid/timestamp/message. Content arrays keep only
 * text blocks (thinking/tool_use/tool_result blocks are dropped). */
export const claudeSessionMapper: SessionMapper = (record) => {
  if (typeof record.type !== 'string' || !claudeRoles.has(record.type))
    return null
  if (typeof record.uuid !== 'string' || !isoTimestamp(record.timestamp))
    return null
  if (!ownObject(record.message)) return null
  const role = record.message.role
  if (typeof role !== 'string' || !claudeRoles.has(role)) return null
  // String content is used directly; block arrays keep text blocks only.
  const text =
    typeof record.message.content === 'string'
      ? record.message.content
      : blockTexts(record.message.content, claudeTextBlocks)
  if (text === null) return null
  return finish(
    record.uuid,
    record.timestamp,
    role as 'user' | 'assistant',
    text,
  )
}

const codexTextBlocks = { user: 'input_text', assistant: 'output_text' } as const

/** Codex rollout line: keep type response_item with payload.type message and
 * payload.role user/assistant; skip session_meta, event_msg, turn_context and
 * reasoning/function_call/web_search_call/token_count/task_* payload items as
 * well as developer messages. The file-local ordinal is the stable row id. */
export const codexSessionMapper: SessionMapper = (record) => {
  if (record.type !== 'response_item') return null
  if (!isoTimestamp(record.timestamp)) return null
  const ordinal = record.ordinal
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0)
    return null
  if (!ownObject(record.payload)) return null
  if (record.payload.type !== 'message') return null
  const role = record.payload.role
  if (role !== 'user' && role !== 'assistant') return null
  const text = blockTexts(
    record.payload.content,
    new Set([codexTextBlocks[role]]),
  )
  if (text === null) return null
  return finish(String(ordinal), record.timestamp, role, text)
}

/** Stable normalizer identities mixed into the read cursor's mapping
 * fingerprint; bump the suffix when a mapper's keep/extract rules change so
 * existing sources rescan instead of resuming with stale rules. */
export const SESSION_NORMALIZER_IDS = {
  'claude-code': 'claude-code-session@1',
  codex: 'codex-session@1',
} as const
export type SessionSourceKind = keyof typeof SESSION_NORMALIZER_IDS
export const SESSION_MAPPERS: Record<SessionSourceKind, SessionMapper> = {
  'claude-code': claudeSessionMapper,
  codex: codexSessionMapper,
}

import type { NormalizedSessionRecord } from './session-mappers'
/** BUGU envelope for real `codex exec --json` stdout, which has no wall clock or
 * user-input event of its own. It is explicitly NOT the rollout file protocol. */
export function mapCodexExecCapture(
  record: Record<string, unknown>,
  byteOffset?: number,
): NormalizedSessionRecord | null {
  const invalid = (): never => {
    throw Error('UNSUPPORTED_SESSION_FORMAT')
  }
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v)
  if (
    record.formatVersion !== 1 ||
    typeof record.timestamp !== 'string' ||
    !record.timestamp.includes('T') ||
    !Number.isFinite(Date.parse(record.timestamp)) ||
    !Number.isSafeInteger(byteOffset) ||
    byteOffset! < 0 ||
    !object(record.payload)
  )
    return invalid()
  const payload = record.payload
  let role: NormalizedSessionRecord['role']
  let content: string
  if (payload.kind === 'input' && typeof payload.text === 'string') {
    role = 'user'
    content = payload.text
  } else if (payload.kind === 'event' && object(payload.event)) {
    const event = payload.event
    if (
      [
        'thread.started',
        'turn.started',
        'turn.completed',
        'item.started',
        'item.updated',
      ].includes(String(event.type))
    )
      return null
    if (event.type !== 'item.completed' || !object(event.item)) return invalid()
    const item = event.item
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      role = 'assistant'
      content = item.text
    } else if (
      item.type === 'command_execution' &&
      typeof item.aggregated_output === 'string'
    ) {
      role = 'tool'
      content = item.aggregated_output
    } else if (item.type === 'reasoning') return null
    else return invalid()
  } else return invalid()
  if (content.length > 4 * 1024 * 1024) return invalid()
  if (!content.trim()) return null
  return {
    id: `offset:${byteOffset}`,
    revision: '1',
    created_at: record.timestamp,
    role,
    content,
  }
}

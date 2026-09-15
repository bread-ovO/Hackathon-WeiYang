import {
  SESSION_MAPPERS,
  SESSION_NORMALIZER_IDS,
} from '../../packages/plugin-host/src/session-mappers'
import type { Format, Message } from '../fixtures/extraction/corpus'
export const FORMAT_VERSION = 'synthetic-jsonl-v1'
export function formatJsonl(messages: Message[], format: Format) {
  const externalToLabel: Record<string, string> = {}
  let content = ''
  for (const [i, message] of messages.entries()) {
    const timestamp = new Date(
      Date.parse('2026-09-15T01:00:00Z') + i * 60000,
    ).toISOString()
    const conversation = message.role === 'user' || message.role === 'assistant'
    const offset = Buffer.byteLength(content)
    let record: unknown,
      externalId = message.id
    if (format === 'generic')
      record = {
        id: message.id,
        revision: '1',
        created_at: timestamp,
        role: message.role,
        content: message.text,
      }
    else if (format === 'codex') {
      externalId = String(i)
      record = {
        type: 'response_item',
        ordinal: i,
        timestamp,
        payload:
          message.role === 'tool'
            ? { type: 'function_call_output', output: message.text }
            : {
                type: 'message',
                role: message.role,
                content: [
                  {
                    type:
                      message.role === 'assistant'
                        ? 'output_text'
                        : 'input_text',
                    text: message.text,
                  },
                ],
              },
      }
    } else if (format === 'claude-code')
      record =
        message.role === 'system'
          ? { type: 'system', content: message.text }
          : {
              type: conversation ? message.role : 'user',
              uuid: message.id,
              timestamp,
              message: {
                role: conversation ? message.role : 'user',
                content: [
                  {
                    type: conversation ? 'text' : 'tool_result',
                    text: message.text,
                  },
                ],
              },
            }
    else {
      externalId = `offset:${offset}`
      record = {
        timestamp: Date.parse(timestamp) / 1000,
        message: {
          type:
            message.role === 'user'
              ? 'TurnBegin'
              : message.role === 'assistant'
                ? 'TextPart'
                : 'ToolResult',
          payload:
            message.role === 'user'
              ? { user_input: message.text }
              : { text: message.text },
        },
      }
    }
    externalToLabel[externalId] = message.id
    content += JSON.stringify(record) + '\n'
  }
  return { content, externalToLabel }
}
export const normalizer = (format: Format) =>
  format === 'generic'
    ? {}
    : {
        normalizeRecord: SESSION_MAPPERS[format],
        normalizerId: SESSION_NORMALIZER_IDS[format],
      }

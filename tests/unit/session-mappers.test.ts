import { describe, expect, it } from 'vitest'
import {
  claudeSessionMapper,
  codexSessionMapper,
  SESSION_MAPPERS,
  SESSION_NORMALIZER_IDS,
} from '../../packages/plugin-host/src/session-mappers'

const claudeLine = (overrides: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid: 'uuid-1',
  timestamp: '2026-09-12T08:30:00.000Z',
  sessionId: 'session-1',
  message: { role: 'user', content: '周五前把接口文档发给小王' },
  ...overrides,
})
const codexLine = (overrides: Record<string, unknown> = {}) => ({
  timestamp: '2026-09-12T08:30:00.000Z',
  ordinal: 3,
  type: 'response_item',
  payload: {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '周五前把接口文档发给小王' }],
  },
  ...overrides,
})

describe('claudeSessionMapper', () => {
  it('keeps user/assistant lines with string content', () => {
    expect(claudeSessionMapper(claudeLine())).toEqual({
      id: 'uuid-1',
      revision: '1',
      created_at: '2026-09-12T08:30:00.000Z',
      role: 'user',
      content: '周五前把接口文档发给小王',
    })
    const assistant = claudeSessionMapper(
      claudeLine({
        type: 'assistant',
        uuid: 'uuid-2',
        message: { role: 'assistant', content: '好的，我来整理。' },
      }),
    )
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.content).toBe('好的，我来整理。')
  })
  it('extracts only text blocks from array content and joins with blank lines', () => {
    const mapped = claudeSessionMapper(
      claudeLine({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '先想想' },
            { type: 'text', text: '第一段' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: '第二段' },
            { type: 'tool_result', content: 'done' },
            'raw-string',
          ],
        },
      }),
    )
    expect(mapped?.content).toBe('第一段\n\n第二段')
  })
  it('skips non-conversational types and malformed lines', () => {
    for (const type of [
      'permission-mode',
      'file-history-snapshot',
      'attachment',
      'queue-operation',
      'system',
    ])
      expect(claudeSessionMapper(claudeLine({ type }))).toBeNull()
    expect(claudeSessionMapper(claudeLine({ uuid: 7 }))).toBeNull()
    expect(claudeSessionMapper(claudeLine({ timestamp: '不是时间' }))).toBeNull()
    expect(claudeSessionMapper(claudeLine({ message: null }))).toBeNull()
    expect(
      claudeSessionMapper(
        claudeLine({ message: { role: 'system', content: 'x' } }),
      ),
    ).toBeNull()
    expect(
      claudeSessionMapper(claudeLine({ message: { role: 'user' } })),
    ).toBeNull()
  })
  it('skips empty extracted text', () => {
    expect(
      claudeSessionMapper(claudeLine({ message: { role: 'user', content: '' } })),
    ).toBeNull()
    expect(
      claudeSessionMapper(
        claudeLine({
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '仅思考' }],
          },
        }),
      ),
    ).toBeNull()
  })
})

describe('codexSessionMapper', () => {
  it('keeps user and assistant message items', () => {
    expect(codexSessionMapper(codexLine())).toEqual({
      id: '3',
      revision: '1',
      created_at: '2026-09-12T08:30:00.000Z',
      role: 'user',
      content: '周五前把接口文档发给小王',
    })
    const assistant = codexSessionMapper(
      codexLine({
        ordinal: 4,
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: '收到。' },
            { type: 'output_text', text: '周四给你初稿。' },
          ],
        },
      }),
    )
    expect(assistant?.id).toBe('4')
    expect(assistant?.content).toBe('收到。\n\n周四给你初稿。')
  })
  it('skips non-message lines, other payload items and developer messages', () => {
    for (const type of ['session_meta', 'event_msg', 'turn_context'])
      expect(codexSessionMapper(codexLine({ type }))).toBeNull()
    for (const payloadType of [
      'reasoning',
      'function_call',
      'function_call_output',
      'web_search_call',
      'custom_tool_call',
      'custom_tool_call_output',
      'token_count',
      'task_started',
      'task_complete',
      'item_completed',
    ])
      expect(
        codexSessionMapper(
          codexLine({ payload: { type: payloadType, role: 'assistant' } }),
        ),
      ).toBeNull()
    expect(
      codexSessionMapper(
        codexLine({
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: '指令' }],
          },
        }),
      ),
    ).toBeNull()
  })
  it('skips malformed lines and empty extracted text', () => {
    expect(codexSessionMapper(codexLine({ ordinal: '3' }))).toBeNull()
    expect(codexSessionMapper(codexLine({ ordinal: -1 }))).toBeNull()
    expect(codexSessionMapper(codexLine({ timestamp: 42 }))).toBeNull()
    expect(codexSessionMapper(codexLine({ payload: 'message' }))).toBeNull()
    expect(
      codexSessionMapper(
        codexLine({
          payload: { type: 'message', role: 'user', content: 'plain' },
        }),
      ),
    ).toBeNull()
    expect(
      codexSessionMapper(
        codexLine({
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '  ' }],
          },
        }),
      ),
    ).toBeNull()
  })
})

describe('session mapper registry', () => {
  it('exposes one versioned normalizer id per kind', () => {
    expect(SESSION_MAPPERS['claude-code']).toBe(claudeSessionMapper)
    expect(SESSION_MAPPERS.codex).toBe(codexSessionMapper)
    expect(SESSION_NORMALIZER_IDS['claude-code']).toMatch(/^claude-code-session@/)
    expect(SESSION_NORMALIZER_IDS.codex).toMatch(/^codex-session@/)
  })
})

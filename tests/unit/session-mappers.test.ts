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
          ],
        },
      }),
    )
    expect(mapped?.content).toBe('第一段\n\n第二段')
  })
  it('skips known metadata but rejects malformed messages', () => {
    for (const type of [
      'permission-mode',
      'file-history-snapshot',
      'attachment',
      'queue-operation',
      'system',
    ])
      expect(claudeSessionMapper(claudeLine({ type }))).toBeNull()
    for (const value of [
      { uuid: 7 },
      { timestamp: 'not-a-time' },
      { message: null },
      { message: { role: 'system', content: 'x' } },
      { message: { role: 'user' } },
      { type: 'future-version' },
      { uuid: 'x'.repeat(257) },
      { message: { role: 'user', content: 'x'.repeat(4 * 1024 * 1024 + 1) } },
      { message: { role: 'user', content: [{ type: 'future_block' }] } },
    ])
      expect(() => claudeSessionMapper(claudeLine(value))).toThrow(
        'UNSUPPORTED_SESSION_FORMAT',
      )
  })
  it('skips empty extracted text', () => {
    expect(
      claudeSessionMapper(
        claudeLine({ message: { role: 'user', content: '' } }),
      ),
    ).toBeNull()
    expect(
      claudeSessionMapper(
        claudeLine({
          type: 'assistant',
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
  it('uses trusted reader offsets for missing/null ordinals and preserves legacy IDs', () => {
    for (const ordinal of [undefined, null]) {
      expect(
        codexSessionMapper(codexLine({ ordinal }), { byteOffset: 123 })?.id,
      ).toBe('offset:123')
      expect(() => codexSessionMapper(codexLine({ ordinal }))).toThrow()
    }
    expect(codexSessionMapper(codexLine(), { byteOffset: 123 })?.id).toBe('3')
  })
  it('skips non-message lines, other payload items and developer messages', () => {
    for (const type of ['session_meta', 'event_msg', 'turn_context'])
      expect(codexSessionMapper(codexLine({ type }))).toBeNull()
    for (const payloadType of [
      'reasoning',
      'function_call',
      'web_search_call',
      'custom_tool_call',
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
    for (const value of [
      { ordinal: '3' },
      { ordinal: -1 },
      { timestamp: 42 },
      { payload: 'message' },
      { type: 'future-version' },
      { payload: { type: 'message', role: 'user', content: 'plain' } },
    ])
      expect(() => codexSessionMapper(codexLine(value))).toThrow(
        'UNSUPPORTED_SESSION_FORMAT',
      )
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
    expect(SESSION_NORMALIZER_IDS['claude-code']).toMatch(
      /^claude-code-session@/,
    )
    expect(SESSION_NORMALIZER_IDS.codex).toMatch(/^codex-session@/)
  })
})

it('imports Kimi wire user input with occurrence time and stable trusted byte offsets', () => {
  const record = {
    timestamp: 1789362000,
    message: {
      type: 'TurnBegin',
      payload: {
        user_input: [
          { type: 'text', text: '我会提交验收报告' },
          { type: 'image_url', image_url: { url: 'data:fictional' } },
        ],
      },
    },
  }
  const result = SESSION_MAPPERS.kimi(record, { byteOffset: 100 })!
  expect(result.role).toBe('user')
  expect(result.created_at).toBe(new Date(1789362000 * 1000).toISOString())
  expect(result.content).toBe('我会提交验收报告')
  expect(result.id).toBe('offset:100')
  expect(() => SESSION_MAPPERS.kimi(record)).toThrow()
  expect(() =>
    SESSION_MAPPERS.kimi({ type: 'metadata', protocol_version: '2.0' }),
  ).toThrow()
  expect(
    SESSION_MAPPERS.kimi({ type: 'metadata', protocol_version: '1.10' }),
  ).toBeNull()
  expect(() =>
    SESSION_MAPPERS.kimi(
      { role: 'user', content: 'context without timestamp' },
      { byteOffset: 0 },
    ),
  ).toThrow()
  expect(
    SESSION_MAPPERS.kimi(
      {
        timestamp: 1789362000,
        message: { type: 'TextPart', payload: { text: '我会提交助手报告' } },
      },
      { byteOffset: 200 },
    )!.role,
  ).toBe('assistant')
})

it('preserves Codex tool output without promoting it to user intent', () => {
  for (const type of ['function_call_output', 'custom_tool_call_output']) {
    const row = codexSessionMapper(
      codexLine({ payload: { type, output: 'tool output' } }),
    )
    expect(row?.role).toBe('tool')
    expect(row?.content).toBe('tool output')
    expect(() =>
      codexSessionMapper(
        codexLine({ payload: { type, output: { unexpected: true } } }),
      ),
    ).toThrow('UNSUPPORTED_SESSION_FORMAT')
  }
})

it('keeps textual parts of multimodal Codex tool results', () => {
  const record = codexSessionMapper(
    codexLine({
      payload: {
        type: 'function_call_output',
        output: [
          { type: 'input_text', text: 'tool result' },
          { type: 'input_image', image_url: 'data:image/png;base64,AA==' },
        ],
      },
    }),
  )
  expect(record?.role).toBe('tool')
  expect(record?.content).toBe('tool result')
})

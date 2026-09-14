import { describe, expect, it } from 'vitest'
import { parseTaskAnalysis } from '../../packages/contracts/src/task-analysis'
import { taskAnalysisCases } from '../fixtures/llm/task-analysis'

const messages = [
  { id: 'm1', role: 'user' as const, text: '修复登录白屏。' },
  { id: 'm2', role: 'assistant' as const, text: '已经完成。' },
  { id: 'm3', role: 'user' as const, text: '验收通过。' },
]
const task = () => ({
  title: '修复登录白屏',
  stage: 'delivered',
  nextAction: '请用户验收登录修复',
  evidence: [
    { messageId: 'm1', quote: '修复登录白屏。' },
    { messageId: 'm2', quote: '已经完成。' },
  ],
})
describe('LLM task proposals are untrusted suggestions', () => {
  it('rejects delivery being mistaken for acceptance when a user only added scope', () => {
    const scoped = [
      ...messages.slice(0, 2),
      { id: 'm4', role: 'user' as const, text: '还要覆盖刷新页面。' },
    ]
    expect(() =>
      parseTaskAnalysis(
        {
          tasks: [
            {
              ...task(),
              stage: 'accepted',
              evidence: [
                ...task().evidence,
                { messageId: 'm4', quote: '还要覆盖刷新页面。' },
              ],
            },
          ],
        },
        scoped,
      ),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
  it('does not invent a next step after an explicit acceptance', () => {
    expect(
      parseTaskAnalysis(
        {
          tasks: [
            {
              ...task(),
              stage: 'accepted',
              nextAction: '',
              evidence: [
                ...task().evidence,
                { messageId: 'm3', quote: '验收通过。' },
              ],
            },
          ],
        },
        messages,
      ).tasks[0]?.nextAction,
    ).toBe('')
    expect(() =>
      parseTaskAnalysis({ tasks: [{ ...task(), nextAction: '' }] }, messages),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
  it('accepts exact bounded evidence, without claiming verified completion', () => {
    expect(
      parseTaskAnalysis({ tasks: [task()] }, messages).tasks[0]?.stage,
    ).toBe('delivered')
  })
  it('allows no actionable tasks', () => {
    expect(parseTaskAnalysis({ tasks: [] }, messages)).toEqual({ tasks: [] })
  })
  it.each([
    { ...task(), status: 'completed' },
    { ...task(), projectId: 'another-project' },
    { ...task(), taskId: 'invented' },
    { ...task(), stage: 'completed' },
    { ...task(), title: '' },
    { ...task(), title: 'x'.repeat(241) },
    { ...task(), evidence: [] },
    {
      ...task(),
      evidence: [{ messageId: 'missing', quote: '修复登录白屏。' }],
    },
    { ...task(), evidence: [{ messageId: 'm1', quote: '已完成登录修复' }] },
    { ...task(), evidence: [{ messageId: 'm2', quote: '已经完成。' }] },
  ])('rejects invented authority, fields, or evidence %#', (value) => {
    expect(() => parseTaskAnalysis({ tasks: [value] }, messages)).toThrow(
      'INVALID_TASK_ANALYSIS',
    )
  })
  it('rejects duplicate proposals with identical source evidence', () => {
    expect(() =>
      parseTaskAnalysis({ tasks: [task(), task()] }, messages),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
  it('rejects acceptance supported only by the original request and assistant claim', () => {
    expect(() =>
      parseTaskAnalysis(
        { tasks: [{ ...task(), stage: 'accepted' }] },
        messages,
      ),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
  it('allows acceptance for review when later user evidence is included', () => {
    expect(
      parseTaskAnalysis(
        {
          tasks: [
            {
              ...task(),
              stage: 'accepted',
              evidence: [
                ...task().evidence,
                { messageId: 'm3', quote: '验收通过。' },
              ],
            },
          ],
        },
        messages,
      ).tasks[0]?.stage,
    ).toBe('accepted')
  })
  it('rejects ambiguous duplicate input message IDs', () => {
    expect(() =>
      parseTaskAnalysis({ tasks: [] }, [...messages, messages[0]!]),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
  it('rejects oversized input and output', () => {
    expect(() =>
      parseTaskAnalysis({ tasks: Array.from({ length: 13 }, task) }, messages),
    ).toThrow('INVALID_TASK_ANALYSIS')
    expect(() =>
      parseTaskAnalysis({ tasks: [] }, [
        { ...messages[0]!, text: 'a'.repeat(65537) },
      ]),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
})

describe('synthetic semantic evaluation corpus', () => {
  it('has distinct cases with traceable expected evidence', () => {
    expect(new Set(taskAnalysisCases.map((c) => c.id)).size).toBe(
      taskAnalysisCases.length,
    )
    for (const c of taskAnalysisCases) {
      expect(c.messages.length).toBeGreaterThan(0)
      for (const id of c.expected.requiredEvidence)
        expect(c.messages.some((m) => m.id === id)).toBe(true)
      expect(c.expected.count === 0).toBe(c.expected.stage === null)
    }
  })
})

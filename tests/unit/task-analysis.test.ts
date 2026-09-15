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
  it('treats stage semantics as an unverified suggestion, not a keyword proof of completion', () => {
    const scoped = [
      ...messages.slice(0, 2),
      { id: 'm4', role: 'user' as const, text: '还要覆盖刷新页面。' },
    ]
    expect(
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
    ).toMatchObject({ tasks: [{ stage: 'accepted' }] })
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
      parseTaskAnalysis(
        { tasks: [{ ...task(), nextAction: '' }] },
        messages,
      ),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
  it('accepts exact bounded evidence, without claiming verified completion', () => {
    expect(
      parseTaskAnalysis({ tasks: [task()] }, messages).tasks[0]?.stage,
    ).toBe('delivered')
  })
  it('allows no actionable tasks', () => {
    expect(parseTaskAnalysis({ tasks: [] }, messages)).toEqual({
      tasks: [],
    })
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
      parseTaskAnalysis(
        { tasks: Array.from({ length: 13 }, task) },
        messages,
      ),
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

describe('model deadline source validation', () => {
  const dated = [
    {
      id: 'date',
      role: 'user' as const,
      text: '明天下午5点前提交报告。',
      occurredAt: '2026-09-14T23:30:00+08:00',
    },
  ]
  const evidence = [{ messageId: 'date', quote: dated[0]!.text }]
  const deadline = { dueAt: '2026-09-15T09:00:00Z', ...evidence[0]! }
  const candidate = {
    title: '提交报告',
    stage: 'requested',
    nextAction: '写报告',
    evidence,
    deadline,
  }
  it('retains exact user source, occurrence time and an explicit UTC deadline', () => {
    expect(
      parseTaskAnalysis({ tasks: [candidate] }, dated).tasks[0]!.deadline,
    ).toEqual(deadline)
  })
  it.each([
    { ...deadline, dueAt: '2026-02-30T09:00:00Z' },
    { ...deadline, dueAt: '2026-09-15T17:00:00+08:00' },
    { ...deadline, dueAt: '2026-09-15T24:00:00Z' },
    { ...deadline, messageId: 'invented' },
    { ...deadline, quote: '下周' },
  ])('rejects fabricated sources and noncanonical dates %#', (value) => {
    expect(() =>
      parseTaskAnalysis(
        { tasks: [{ ...candidate, deadline: value }] },
        dated,
      ),
    ).toThrow('INVALID_TASK_ANALYSIS')
  })
  it('requires occurrence time, user authority and inclusion in task evidence', () => {
    expect(() =>
      parseTaskAnalysis({ tasks: [candidate] }, [
        { ...dated[0]!, occurredAt: undefined },
      ]),
    ).toThrow()
    const extra = {
      id: 'assistant',
      role: 'assistant' as const,
      text: dated[0]!.text,
      occurredAt: dated[0]!.occurredAt,
    }
    expect(() =>
      parseTaskAnalysis(
        {
          tasks: [
            {
              ...candidate,
              deadline: { ...deadline, messageId: 'assistant' },
            },
          ],
        },
        [...dated, extra],
      ),
    ).toThrow()
    expect(() =>
      parseTaskAnalysis(
        {
          tasks: [
            {
              ...candidate,
              evidence: [{ messageId: 'date', quote: '提交报告' }],
            },
          ],
        },
        dated,
      ),
    ).toThrow()
  })
})

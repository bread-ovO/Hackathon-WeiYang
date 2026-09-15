import { it, expect } from 'vitest'
import { prefixCases } from '../fixtures/extraction/time-prefix'
import { parseTaskAnalysis } from '@memo/contracts'
it('contains 30 labeled chains and reveals only the selected prefix', () => {
  expect(prefixCases).toHaveLength(156)
  expect(new Set(prefixCases.map((c) => c.id.split('-prefix-')[0])).size).toBe(
    30,
  )
  for (const c of prefixCases) {
    const n = Number(c.id.split('-prefix-')[1])
    expect(c.messages).toHaveLength(n)
    expect(new Set(c.messages.map((m) => m.id)).size).toBe(n)
    if (n < 5)
      expect(c.messages.some((m) => m.text.includes('2026年9月20日'))).toBe(
        false,
      )
  }
})
it('rejects future references and unknown change classifications while retaining historical proposals', () => {
  const c = prefixCases[0]!,
    e = { messageId: c.messages[0]!.id, quote: c.messages[0]!.text }
  const task = {
    title: '修复登录白屏',
    stage: 'requested',
    changeKind: 'commitment',
    nextAction: '修复',
    evidence: [e],
  }
  expect(parseTaskAnalysis({ tasks: [task] }, c.messages).tasks).toHaveLength(1)
  expect(() =>
    parseTaskAnalysis(
      { tasks: [{ ...task, changeKind: 'auto_complete' }] },
      c.messages,
    ),
  ).toThrow()
  expect(() =>
    parseTaskAnalysis(
      {
        tasks: [
          {
            ...task,
            evidence: [e, { messageId: 'c0_m5', quote: '取消修复登录白屏' }],
          },
        ],
      },
      c.messages,
    ),
  ).toThrow()
  const { changeKind: _, ...legacy } = task
  expect(parseTaskAnalysis({ tasks: [legacy] }, c.messages).tasks).toHaveLength(
    1,
  )
})

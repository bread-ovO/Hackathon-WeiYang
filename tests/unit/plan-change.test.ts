import { describe, it, expect } from 'vitest'
import { extractExplicitPlanChange } from '../../packages/domain/src/plan-change'
describe('bounded explicit absolute plan grammar', () => {
  it('normalizes offset and preserves exact quote', () => {
    const text = '我将截止时间改为 2026-09-20T18:00:00+08:00。'
    expect(extractExplicitPlanChange({ text, role: 'user' })).toEqual({
      dueAt: '2026-09-20T10:00:00.000Z',
      quoteStart: 0,
      quoteEnd: text.length,
      quote: text,
    })
  })
  it.each([
    '截止时间改为 明天',
    '如果截止时间改为 2026-09-20T10:00:00Z',
    '> 截止时间改为 2026-09-20T10:00:00Z',
    '截止时间改为 2026-02-30T10:00:00Z',
    '截止时间改为 2026-09-20T10:00:00',
    '截止时间改为 2026-09-20T10:00:00Z\n我会提交报告',
    '不要截止时间改为 2026-09-20T10:00:00Z',
  ])('rejects ambiguous, quoted, invalid or compound input %s', (text) =>
    expect(extractExplicitPlanChange({ text, role: 'user' })).toBeNull(),
  )
  it.each(['assistant', 'tool', 'system'])('rejects role %s', (role) =>
    expect(
      extractExplicitPlanChange({
        text: '截止时间改为 2026-09-20T10:00:00Z',
        role,
      }),
    ).toBeNull(),
  )
})

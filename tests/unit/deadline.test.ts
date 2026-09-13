import { it, expect } from 'vitest'
import { resolveDeadline, extractExplicitCommitments } from '@memo/domain'
const at = '2026-09-14T23:30:00+08:00'
it.each([
  ['我会明天下午5点前提交报告', '2026-09-15T09:00:00.000Z'],
  ['明天，我会提交报告', '2026-09-15T15:59:59.999Z'],
  ['我会在周五前提交报告', '2026-09-18T15:59:59.999Z'],
  ['我会提交报告，截止2026-10-01 16:30', '2026-10-01T08:30:00.000Z'],
  ['下周一上午9点，我会提交报告', '2026-09-21T01:00:00.000Z'],
  ['我会提交周五评审所需的报告', null],
  ['我会提交明天的会议纪要', null],
  ['我会明天或后天提交报告', null],
  ['我会明天下午提交报告', null],
  ['我会2026-02-30前提交报告', null],
  ['我会明天25点前提交报告', null],
  ['我会明天大概5点提交报告', null],
])('conservative occurrence-relative parsing: %s', (text, due) =>
  expect(resolveDeadline(text, at)).toBe(due),
)
it('preserves exact quote and title while extracting an offset-relative deadline', () => {
  const text = '  明天下午5点前，我会提交报告。'
  const c = extractExplicitCommitments({ text, role: 'user', occurredAt: at })
    .candidates[0]!
  expect(c.dueAt).toBe('2026-09-15T09:00:00.000Z')
  expect(text.slice(c.quoteStart, c.quoteEnd)).toBe(text.trim())
  expect(c.title).toBe('提交报告')
})
it('keeps day rollover tied to the occurrence timezone, not import clock', () => {
  expect(resolveDeadline('明天前', '2026-12-31T23:30:00-05:00')).toBe(
    '2027-01-02T04:59:59.999Z',
  )
  expect(resolveDeadline('明天前', '2026-09-14T09:00:00')).toBeNull()
})

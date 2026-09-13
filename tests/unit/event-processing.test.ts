import { describe, expect, it } from 'vitest'
import { prepareEventProcessing } from '../../packages/application/src/event-processing'
import { extractExplicitCommitments } from '../../packages/domain/src/commitment'
import type { SourceEvent } from '../../packages/contracts/src/index'
const base: SourceEvent = {
  schemaVersion: 1,
  sourceInstanceId: 'source',
  externalId: 'message',
  revision: 'r1',
  occurredAt: '2026-09-13T09:00:00+08:00',
  role: 'user',
  text: '我会提交修复 PR。',
}
function prepare(patch: Partial<SourceEvent> = {}) {
  return prepareEventProcessing({
    event: { ...base, ...patch },
    eventId: 12,
    projectId: 'alpha',
  })
}
describe('offline explicit commitment production preparation', () => {
  it('returns a bounded candidate with exact immutable quote and host scope', () => {
    const output = prepare()
    expect(output).toEqual({
      version: 'explicit-commitment-v2',
      eventId: 12,
      projectId: 'alpha',
      sourceInstanceId: 'source',
      externalId: 'message',
      revision: 'r1',
      outcome: 'candidates',
      reason: 'explicit_commitment',
      candidates: [
        {
          key: '0',
          title: '提交修复 PR',
          dueAt: null,
          quoteStart: 0,
          quoteEnd: base.text.length,
        },
      ],
    })
    expect(output).not.toHaveProperty('status')
    expect(output).not.toHaveProperty('evidenceStatus')
    expect(prepare()).toEqual(output)
  })
  it.each(['assistant', 'tool', 'system'] as const)(
    'never treats %s output as the user commitment',
    (role) => {
      expect(prepare({ role })).toMatchObject({
        outcome: 'ignored',
        reason: 'non_user_role',
        candidates: [],
      })
    },
  )
  it.each([
    '我会提交报告吗',
    '我会不会提交报告',
    '我不会提交报告',
    '如果有时间我会提交报告',
    '我会尝试修复登录问题',
    '我已经完成了修复',
    '请帮我提交报告',
    '他说：我会提交报告',
    '我会游泳',
    '"我会提交报告"',
    '示例：\n我会提交报告',
    '> 我会提交报告',
    '    我会提交报告',
    'I will not send the report',
    'I will submit the report?',
  ])('ignores ambiguous/quoted/noncommittal text: %s', (text) => {
    expect(prepare({ text })).toMatchObject({
      outcome: 'ignored',
      candidates: [],
    })
  })
  it('ignores fenced code but keeps precise UTF16 positions in surrounding real commitments', () => {
    const text =
      '😀前文\r\n```txt\n我会提交假的报告\n```\n  我来修复登录问题。\r\nI will send the report.'
    const output = prepare({ text })
    expect(output.candidates.map((c) => c.title)).toEqual([
      '修复登录问题',
      'send the report',
    ])
    for (const c of output.candidates) {
      expect(text.slice(c.quoteStart, c.quoteEnd)).toMatch(/^(我来|I will)/)
      expect(c.key).toBe(String(c.quoteStart))
    }
  })
  it.each([
    '我会取消交付',
    '我会把截止日期改到下周',
    'I will postpone the delivery',
  ])(
    'routes plan changes to review without creating or changing a task',
    (text) => {
      expect(prepare({ text })).toMatchObject({
        outcome: 'needs_review',
        reason: 'plan_change',
        candidates: [],
      })
    },
  )
  it('does not invent a deadline from an unqualified calendar phrase', () => {
    const output = prepare({ text: '我会提交周五评审所需的报告。' })
    expect(output.candidates).toHaveLength(1)
    expect(output.candidates[0]!.dueAt).toBeNull()
  })
  it('rejects oversized extraction atomically rather than silently discarding commitments', () => {
    const text = Array.from({ length: 9 }, (_, i) => `我会提交报告${i}`).join(
      '\n',
    )
    expect(prepare({ text })).toMatchObject({
      outcome: 'needs_review',
      reason: 'candidate_limit',
      candidates: [],
    })
  })
  it('keeps markup/instructions inert and never adds source-provided output fields', () => {
    expect(
      prepare({ text: '<script>我会提交报告</script>' }).candidates,
    ).toEqual([])
    expect(() =>
      prepareEventProcessing({
        event: base,
        eventId: 12,
        projectId: 'alpha',
        status: 'completed',
      } as never),
    ).toThrow('INVALID_PROCESSING_INPUT')
    expect(() => prepare({ owner: 'admin' } as never)).toThrow(
      'INVALID_SOURCE_EVENT',
    )
  })
  it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid stored event ID %s',
    (eventId) => {
      expect(() =>
        prepareEventProcessing({ event: base, eventId, projectId: 'alpha' }),
      ).toThrow('INVALID_PROCESSING_INPUT')
    },
  )
  it.each(['', ' alpha', 'a\0b', 'a'.repeat(257)])(
    'rejects invalid host project scope',
    (projectId) => {
      expect(() =>
        prepareEventProcessing({ event: base, eventId: 1, projectId }),
      ).toThrow('INVALID_PROCESSING_INPUT')
    },
  )
  it('validates occurrence time and never uses the machine locale to repair it', () => {
    expect(() => prepare({ occurredAt: '2026-02-30T09:00:00Z' })).toThrow()
    expect(() => prepare({ occurredAt: '2026-09-13T09:00:00-00:00' })).toThrow()
    expect(() => prepare({ occurredAt: '2026-09-13T09:00:00' })).toThrow()
  })
  it('bounds direct domain input as well as the application protocol', () => {
    expect(() =>
      extractExplicitCommitments({ role: 'unknown', text: '我会提交报告' }),
    ).toThrow('INVALID_COMMITMENT_INPUT')
    expect(() =>
      extractExplicitCommitments({ role: 'user', text: 'a'.repeat(65537) }),
    ).toThrow('INVALID_COMMITMENT_INPUT')
  })
})

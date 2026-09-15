import { describe, expect, it } from 'vitest'
import { prepareEventProcessing } from '../../packages/application/src/event-processing'
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
describe('source observation never creates rule tasks', () => {
  it.each([
    '我会提交修复 PR。',
    '请帮我整理会议纪要。',
    '发版说明我来写。',
    '我会取消交付',
    'I will send the report.',
    '示例：我会提交报告。',
  ])('defers every semantic decision to the model: %s', (text) => {
    const output = prepare({ text })
    expect(output).toMatchObject({
      version: 'source-observation-v3',
      outcome: 'ignored',
      reason: 'model_required',
      candidates: [],
    })
    expect(output).not.toHaveProperty('status')
    expect(output).not.toHaveProperty('evidenceStatus')
  })
  it.each(['assistant', 'tool', 'system'] as const)(
    'does not build candidates from %s output',
    (role) => {
      expect(prepare({ role }).candidates).toEqual([])
    },
  )
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
})

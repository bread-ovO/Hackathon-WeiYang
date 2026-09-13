import { describe, it, expect } from 'vitest'
import { parseSourceEvent } from '../../packages/contracts/src/index'
import { prepareEventProcessing } from '../../packages/application/src/event-processing'
import { extractExplicitCommitments } from '../../packages/domain/src/commitment'
const event = {
  schemaVersion: 1 as const,
  sourceInstanceId: 's',
  externalId: 'm',
  revision: '1',
  occurredAt: '2026-09-13T00:00:00Z',
  role: 'user' as const,
  text: '我会提交报告',
}
describe('explicit event retraction', () => {
  it('keeps the v1 envelope and legacy upsert proposal compatible', () => {
    expect(parseSourceEvent(event)).toEqual(event)
    expect(
      prepareEventProcessing({ event, eventId: 1, projectId: 'p' }),
    ).toEqual(
      prepareEventProcessing({
        event: { ...event, operation: 'upsert' },
        eventId: 1,
        projectId: 'p',
      }),
    )
  })
  it.each(['user', 'assistant', 'tool', 'system'] as const)(
    'never extracts a commitment from %s retraction',
    (role) => {
      const retract = {
        ...event,
        role,
        operation: 'retract' as const,
        text: '',
      }
      expect(parseSourceEvent(retract)).toEqual(retract)
      expect(
        prepareEventProcessing({ event: retract, eventId: 1, projectId: 'p' }),
      ).toMatchObject({
        outcome: 'needs_review',
        reason: 'source_retracted',
        candidates: [],
      })
    },
  )
  it.each([null, true, 1, {}, [], 'delete', 'RETRACT'])(
    'rejects operation %j',
    (operation) => {
      expect(() => parseSourceEvent({ ...event, text: '', operation })).toThrow(
        'INVALID_SOURCE_EVENT',
      )
    },
  )
  it.each([' ', '此消息已撤回', '我会提交报告'])(
    'rejects nonempty retraction text',
    (text) => {
      expect(() =>
        parseSourceEvent({ ...event, operation: 'retract', text }),
      ).toThrow('INVALID_SOURCE_EVENT')
      expect(() =>
        extractExplicitCommitments({
          text,
          operation: 'retract',
          role: 'user',
        }),
      ).toThrow('INVALID_COMMITMENT_INPUT')
    },
  )
  it('does not treat empty content or body keywords as an operation', () => {
    for (const text of ['', '此消息已撤回']) {
      const result = prepareEventProcessing({
        event: { ...event, text },
        eventId: 1,
        projectId: 'p',
      })
      expect(result.reason).not.toBe('source_retracted')
    }
    expect(() => parseSourceEvent({ ...event, deleted: true })).toThrow(
      'INVALID_SOURCE_EVENT',
    )
  })
})

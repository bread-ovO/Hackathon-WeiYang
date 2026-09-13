import { describe, expect, it } from 'vitest'
import { eventTimeContext } from '../../packages/storage/src/event-context'
import {
  comparePlanUpdates,
  normalizeIdentity,
} from '../../packages/domain/src/context'

describe('production event context projection', () => {
  it('preserves original offsets and host reception separately from UTC occurrence', () => {
    const result = eventTimeContext(
      { occurredAt: '2026-09-13T09:00:00+08:00' },
      '2026-09-14T12:00:00.123Z',
    )
    expect(result.occurred.utc).toBe('2026-09-13T01:00:00.000000000Z')
    expect(result.occurred.original).toBe('2026-09-13T09:00:00+08:00')
    expect(result.occurred.offsetMinutes).toBe(480)
    expect(result.received.original).toBe('2026-09-14T12:00:00.123Z')
    expect(result.sourceTimeZone).toBeNull()
    expect(result.parsingBasis).toBe('explicit_offset')
  })
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-09-13T10:00:00',
    '2026-09-13T00:00:00-00:00',
    '2026-09-13T00:00:00+15:00',
  ])('rejects ambiguous or invalid occurrence %s', (occurredAt) => {
    expect(() =>
      eventTimeContext({ occurredAt }, '2026-09-14T00:00:00Z'),
    ).toThrow()
  })
  it('supports equivalent DST instants without guessing the named timezone', () => {
    const a = eventTimeContext(
      { occurredAt: '2026-11-01T01:30:00-04:00' },
      '2026-11-02T00:00:00Z',
    )
    const b = eventTimeContext(
      { occurredAt: '2026-11-01T05:30:00Z' },
      '2026-11-02T00:00:00Z',
    )
    expect(a.occurred.utc).toBe(b.occurred.utc)
  })
  it('provides explicitly scoped objects to plan comparison without arrival-order overwrite', () => {
    const identity = normalizeIdentity({
      sourceInstanceId: 's',
      namespace: 'source-event',
      subjectId: 'object',
      projectId: 'alpha',
    })
    const current = {
      identity,
      eventId: 'm1',
      revision: '1',
      planFingerprint: 'deadline:new',
      time: {
        occurredAt: '2026-09-13T10:00:00Z',
        receivedAt: '2026-09-13T10:01:00Z',
      },
    }
    const incoming = {
      ...current,
      eventId: 'm2',
      planFingerprint: 'deadline:old',
      time: {
        occurredAt: '2026-09-12T10:00:00Z',
        receivedAt: '2026-09-14T10:00:00Z',
      },
    }
    expect(comparePlanUpdates(current, incoming)).toEqual({
      action: 'keep',
      reason: 'late_occurrence',
    })
    expect(
      comparePlanUpdates(current, {
        ...incoming,
        identity: { ...identity, key: undefined, projectId: 'beta' },
      }),
    ).toEqual({ action: 'confirm', reason: 'different_scope' })
  })
})

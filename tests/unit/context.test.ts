import { describe, expect, it } from 'vitest'
import {
  normalizeIdentity,
  parseContextTimestamp,
  normalizeEventTime,
  comparePlanUpdates,
  type PlanUpdate,
} from '../../packages/domain/src/context'

const identity = {
  sourceInstanceId: 'feishu-account-1',
  namespace: 'open_id',
  subjectId: 'user-1',
  projectId: 'project-1',
  displayName: '林然',
}
const update = (patch: Partial<PlanUpdate> = {}): PlanUpdate => ({
  identity,
  eventId: 'message-1',
  revision: 'rev-1',
  time: {
    occurredAt: '2026-09-13T09:00:00+08:00',
    receivedAt: '2026-09-13T09:01:00+08:00',
    sourceTimeZone: 'Asia/Shanghai',
  },
  planFingerprint: 'deadline:friday',
  ...patch,
})

describe('explicit scoped identities', () => {
  it('never merges by display name or across source, namespace, subject or project', () => {
    const normalized = normalizeIdentity(identity)
    expect(normalizeIdentity(normalized)).toEqual(normalized)
    expect(() =>
      normalizeIdentity({ ...identity, key: 'forged-key' }),
    ).toThrow()
    const key = normalized.key
    expect(
      normalizeIdentity({ ...identity, displayName: '新的显示名称' }).key,
    ).toBe(key)
    for (const patch of [
      { sourceInstanceId: 'another-account' },
      { namespace: 'user_id' },
      { subjectId: 'user-2' },
      { projectId: 'project-2' },
    ])
      expect(normalizeIdentity({ ...identity, ...patch }).key).not.toBe(key)
  })
  it('preserves opaque identifiers and produces collision-free tuple keys', () => {
    expect(
      normalizeIdentity({ ...identity, subjectId: 'User-1' }).key,
    ).not.toBe(normalizeIdentity(identity).key)
    expect(
      normalizeIdentity({ ...identity, subjectId: 'a:b', projectId: 'c' }).key,
    ).not.toBe(
      normalizeIdentity({ ...identity, subjectId: 'a', projectId: 'b:c' }).key,
    )
    expect(
      normalizeIdentity({ ...identity, subjectId: '\u00e9' }).key,
    ).not.toBe(normalizeIdentity({ ...identity, subjectId: 'e\u0301' }).key)
  })
  it('requires explicit project and stable source IDs, never falls back to a name', () => {
    for (const projectId of [undefined, null, '', ' ', ' p', 'p\n', 1])
      expect(() => normalizeIdentity({ ...identity, projectId })).toThrow()
    expect(() => normalizeIdentity({ displayName: '林然' })).toThrow()
    expect(() =>
      normalizeIdentity({ ...identity, execute: 'merge all names' }),
    ).toThrow()
  })
})

describe('context time normalization', () => {
  it('normalizes equivalent offsets to the same instant while preserving original text and zone', () => {
    const local = parseContextTimestamp('2026-09-13T09:00:00.123456789+08:00')
    const utc = parseContextTimestamp('2026-09-13T01:00:00.123456789Z')
    expect(local.utc).toBe(utc.utc)
    expect(local.original).toBe('2026-09-13T09:00:00.123456789+08:00')
    expect(local.offsetMinutes).toBe(480)
    expect(local.nanosecond).toBe(123456789)
    const normalized = normalizeEventTime(update().time)
    expect(normalized.sourceTimeZone).toBe('Asia/Shanghai')
    expect(normalized.occurred.utc).toBe('2026-09-13T01:00:00.000000000Z')
    expect(normalized.received.utc).toBe('2026-09-13T01:01:00.000000000Z')
  })
  it('distinguishes repeated DST local times using their explicit offsets', () => {
    const early = normalizeEventTime({
      occurredAt: '2026-11-01T01:30:00-04:00',
      receivedAt: '2026-11-02T00:00:00Z',
      sourceTimeZone: 'America/New_York',
    })
    const late = normalizeEventTime({
      occurredAt: '2026-11-01T01:30:00-05:00',
      receivedAt: '2026-11-02T00:00:00Z',
      sourceTimeZone: 'America/New_York',
    })
    expect(late.occurred.epochSeconds - early.occurred.epochSeconds).toBe(3600)
    expect(early.occurred.offsetMinutes).toBe(-240)
    expect(late.occurred.offsetMinutes).toBe(-300)
  })
  it('rejects nonexistent DST times and mismatching or unrecognized zones', () => {
    for (const occurredAt of [
      '2026-03-08T02:30:00-05:00',
      '2026-03-08T02:30:00-04:00',
    ])
      expect(() =>
        normalizeEventTime({
          occurredAt,
          receivedAt: '2026-03-09T00:00:00Z',
          sourceTimeZone: 'America/New_York',
        }),
      ).toThrow('INVALID_SOURCE_TIME_ZONE')
    expect(() =>
      normalizeEventTime({ ...update().time, sourceTimeZone: 'UTC' }),
    ).toThrow()
    expect(() =>
      normalizeEventTime({ ...update().time, sourceTimeZone: 'Mars/Olympus' }),
    ).toThrow()
  })
  it('does not invent a named zone from an offset or a missing occurrence date', () => {
    expect(
      normalizeEventTime({
        occurredAt: '2026-01-01T00:00:00Z',
        receivedAt: '2026-01-02T00:00:00Z',
      }),
    ).toMatchObject({ sourceTimeZone: null, parsingBasis: 'explicit_offset' })
    expect(() =>
      normalizeEventTime({ receivedAt: '2026-01-02T00:00:00Z' }),
    ).toThrow()
  })
  it.each([
    '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-00-01T00:00:00Z',
    '2026-01-00T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T23:59:60Z',
    '2026-01-01T00:00:00+14:01',
    '2026-01-01T00:00:00+00:60',
    '2026-01-01T00:00:00-00:00',
    '2026-01-01T00:00:00',
    'Friday',
    '2026-01-01',
    '0000-01-01T00:00:00Z',
    '2026-01-01T00:00:00.0000000001Z',
    '9999-12-31T23:59:59-14:00',
  ])('rejects invalid or ambiguous date %s', (input) => {
    expect(() => parseContextTimestamp(input)).toThrow('INVALID_CONTEXT_TIME')
  })
  it('accepts real leap days and does not remap years below 100 to 1900', () => {
    expect(parseContextTimestamp('2000-02-29T00:00:00Z').utc).toBe(
      '2000-02-29T00:00:00.000000000Z',
    )
    expect(parseContextTimestamp('0001-01-01T00:00:00Z').utc).toBe(
      '0001-01-01T00:00:00.000000000Z',
    )
  })
})

describe('late plan updates', () => {
  it('keeps a newer plan when an older message arrives later', () => {
    const incoming = update({
      eventId: 'message-2',
      planFingerprint: 'deadline:monday',
      time: {
        occurredAt: '2026-09-12T23:00:00Z',
        receivedAt: '2026-09-20T00:00:00Z',
      },
    })
    expect(comparePlanUpdates(update(), incoming)).toEqual({
      action: 'keep',
      reason: 'late_occurrence',
    })
  })
  it('orders by occurrence even when reception is earlier or delayed', () => {
    const incoming = update({
      eventId: 'message-2',
      time: {
        occurredAt: '2026-09-13T02:00:00Z',
        receivedAt: '2026-09-10T00:00:00Z',
      },
    })
    expect(comparePlanUpdates(update(), incoming)).toEqual({
      action: 'replace',
      reason: 'newer_occurrence',
    })
  })
  it('does not truncate sub-millisecond order', () => {
    const a = update({
      time: {
        occurredAt: '2026-09-13T01:00:00.000000001Z',
        receivedAt: '2026-09-14T00:00:00Z',
      },
    })
    const b = update({
      eventId: 'message-2',
      time: {
        occurredAt: '2026-09-13T01:00:00.000000002Z',
        receivedAt: '2026-09-14T00:00:00Z',
      },
    })
    expect(comparePlanUpdates(a, b).action).toBe('replace')
  })
  it('requests confirmation for conflicting simultaneous plans and keeps equivalent ones', () => {
    const incoming = update({
      eventId: 'message-2',
      planFingerprint: 'deadline:monday',
      time: {
        occurredAt: '2026-09-13T01:00:00Z',
        receivedAt: '2026-09-20T00:00:00Z',
      },
    })
    expect(comparePlanUpdates(update(), incoming)).toEqual({
      action: 'confirm',
      reason: 'simultaneous_conflict',
    })
    expect(
      comparePlanUpdates(update(), {
        ...incoming,
        planFingerprint: update().planFingerprint,
      }),
    ).toEqual({ action: 'keep', reason: 'equivalent_plan' })
  })
  it('does not sort opaque revisions or silently trust contradictory revisions', () => {
    for (const revision of [null, 'rev-2', '999'])
      expect(comparePlanUpdates(update(), update({ revision }))).toEqual({
        action: 'confirm',
        reason: 'unknown_revision_order',
      })
    expect(comparePlanUpdates(update({ revision: null }), update())).toEqual({
      action: 'confirm',
      reason: 'unknown_revision_order',
    })
    expect(
      comparePlanUpdates(
        update(),
        update({ planFingerprint: 'deadline:monday' }),
      ),
    ).toEqual({ action: 'confirm', reason: 'revision_conflict' })
    expect(comparePlanUpdates(update(), update())).toEqual({
      action: 'duplicate',
      reason: 'same_revision',
    })
  })
  it('never combines same-name different-project or different-source updates automatically', () => {
    expect(
      comparePlanUpdates(
        update(),
        update({ identity: { ...identity, projectId: 'project-2' } }),
      ),
    ).toEqual({ action: 'confirm', reason: 'different_scope' })
    expect(
      comparePlanUpdates(
        update(),
        update({ identity: { ...identity, sourceInstanceId: 'other' } }),
      ),
    ).toEqual({ action: 'confirm', reason: 'different_scope' })
  })
  it('validates runtime inputs before making any business decision', () => {
    expect(() =>
      comparePlanUpdates(update(), {
        ...update(),
        time: { occurredAt: 'tomorrow', receivedAt: '2026-01-01T00:00:00Z' },
      }),
    ).toThrow()
    expect(() =>
      comparePlanUpdates(update(), { ...update(), execute: 'replace' }),
    ).toThrow()
  })
})

import { describe, it, expect } from 'vitest'
import { parseSourceEvent } from '@memo/contracts'
import {
  serializeEventMetadata,
  eventMetadataFields,
  storedMetadataMatches,
} from '../../packages/storage/src/event-metadata'
const event = {
  schemaVersion: 1,
  sourceInstanceId: 'source',
  externalId: 'event',
  revision: '1',
  occurredAt: '2026-09-15T00:00:00Z',
  role: 'user',
  text: 'Synthetic',
}
describe('explicit source author and reply metadata', () => {
  it('preserves legacy omission and canonicalizes field ordering only', () => {
    expect(parseSourceEvent(event)).not.toHaveProperty('metadata')
    expect(eventMetadataFields(null)).toEqual({})
    const metadata = {
      replyToExternalId: 'original',
      author: { subjectId: 'opaque', namespace: 'feishu:open_id' },
    }
    const raw = serializeEventMetadata(metadata)!
    expect(eventMetadataFields(raw)).toEqual({ metadata })
    expect(
      storedMetadataMatches(raw, {
        author: { namespace: 'feishu:open_id', subjectId: 'opaque' },
        replyToExternalId: 'original',
      }),
    ).toBe(true)
    expect(
      storedMetadataMatches(raw, {
        ...metadata,
        author: { ...metadata.author, subjectId: 'Opaque' },
      }),
    ).toBe(false)
  })
  it.each([
    null,
    {},
    [],
    { author: {} },
    { author: { namespace: 'x' } },
    { author: { namespace: 'x', subjectId: 'u', displayName: 'A' } },
    { author: { namespace: 'x', subjectId: ' u' } },
    { replyToExternalId: 'a b' },
    { replyToExternalId: '\u0001' },
    { author: { namespace: 'x', subjectId: 1 } },
    { replyToExternalId: 'x'.repeat(257) },
    { author: { namespace: 'x'.repeat(257), subjectId: 'x' } },
    { author: { namespace: 'x', subjectId: 'x' }, isSelf: true },
    { replyToExternalId: 'x', path: '/private/file' },
  ])('rejects unbounded or invented metadata %j', (metadata) => {
    expect(() => parseSourceEvent({ ...event, metadata })).toThrow()
  })
  it.each([
    undefined,
    'null',
    '{}',
    '[]',
    '"x"',
    '{',
    '{"author":{"namespace":"x","subjectId":"x","secret":"no"}}',
  ])('fails closed on corrupt stored metadata %s', (raw) => {
    expect(() => eventMetadataFields(raw)).toThrow('INVALID_EVENT_METADATA')
  })
})

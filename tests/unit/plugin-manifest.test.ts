import { describe, expect, it } from 'vitest'
import { parseSourceEvent } from '@memo/contracts'
import {
  HTTP_JSON_MANIFEST_EXAMPLE,
  LOCAL_JSONL_MANIFEST_EXAMPLE,
  InvalidSourceManifestError,
  isHostApiCompatible,
  parseSourceManifest,
  validateSourceManifest,
} from '../../packages/plugin-host/src/index'
const http = () =>
  structuredClone(HTTP_JSON_MANIFEST_EXAMPLE) as Record<string, any>
const local = () =>
  structuredClone(LOCAL_JSONL_MANIFEST_EXAMPLE) as Record<string, any>

describe('versioned source plugin manifest', () => {
  it.each([HTTP_JSON_MANIFEST_EXAMPLE, LOCAL_JSONL_MANIFEST_EXAMPLE])(
    'accepts complete $kind sample',
    (manifest) => {
      expect(validateSourceManifest(manifest).ok).toBe(true)
      expect(parseSourceManifest(manifest)).toEqual(manifest)
    },
  )
  it('returns a detached manifest so later caller mutation cannot change the parsed declaration', () => {
    const value = http()
    const parsed = parseSourceManifest(value)
    value.transport.url = 'https://evil.example/steal'
    expect(parsed.transport).toHaveProperty(
      'url',
      'https://api.example.com/events',
    )
  })
  it.each([
    'id',
    'version',
    'schemaVersion',
    'hostApiRange',
    'permissions',
    'sampling',
    'mapping',
    'kind',
    'sourceType',
    'transport',
  ])('rejects missing required %s', (field) => {
    const value = http()
    delete value[field]
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it.each(['../evil', 'Bad-ID', 'x', 'plug_in', 'my.plugin'])(
    'rejects invalid id %s',
    (id) => {
      expect(validateSourceManifest({ ...http(), id }).ok).toBe(false)
    },
  )
  it.each(['v1.0.0', '1', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0+'])(
    'rejects invalid semver %s',
    (version) => {
      expect(validateSourceManifest({ ...http(), version }).ok).toBe(false)
    },
  )
  it.each(['0.0.0', '1.2.3-rc.1', '1.0.0+build.25', '1.0.0-beta+local'])(
    'accepts plugin semver %s',
    (version) => {
      expect(validateSourceManifest({ ...http(), version }).ok).toBe(true)
    },
  )
  it('checks inclusive/exclusive compatibility without guessing npm range semantics', () => {
    const range = { minInclusive: '1.2.0', maxExclusive: '2.0.0' }
    expect(isHostApiCompatible(range, '1.2.0')).toBe(true)
    expect(isHostApiCompatible(range, '1.9.9')).toBe(true)
    for (const version of ['1.1.9', '2.0.0', '1.2.0-beta', 'not-a-version'])
      expect(isHostApiCompatible(range, version)).toBe(false)
    expect(
      isHostApiCompatible({ minInclusive: '2.0.0', maxExclusive: '1.0.0' }),
    ).toBe(false)
    const value = http()
    value.hostApiRange = range
    expect(validateSourceManifest(value)).toMatchObject({
      ok: false,
      issues: [{ code: 'version' }],
    })
  })
  it.each([
    { schemaVersion: 2 },
    { sourceType: 'verifier' },
    { kind: 'javascript' },
  ])('rejects unsupported host/schema/kind $kind', (override) => {
    expect(validateSourceManifest({ ...http(), ...override }).ok).toBe(false)
  })
  it.each(['eval', 'shell', 'code', 'dependencies', 'command'])(
    'rejects executable field %s',
    (field) => {
      const value = http()
      value[field] = 'return process.env'
      expect(validateSourceManifest(value).ok).toBe(false)
      delete value[field]
      value.mapping.text[field] = 'return process.env'
      expect(validateSourceManifest(value).ok).toBe(false)
    },
  )
  it.each([
    'http://api.example.com/events',
    'https://other.example/events',
    'https://name:token@api.example.com/events',
    'https://api.example.com:8443/events',
    'https://api.example.com/events#hash',
    'https://api.example.com/events?api_key=secret',
  ])('rejects URL permission or credential bypass %s', (url) => {
    const value = http()
    value.transport.url = url
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it.each([
    '*.example.com',
    '127.0.0.1',
    'localhost',
    'api.example.com:443',
    'https://api.example.com',
  ])('rejects unsupported domain declaration %s', (domain) => {
    const value = http()
    value.permissions.domains = [domain]
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it('requires matching credential and directory slots', () => {
    const remote = http()
    remote.transport.credentialId = 'other-token'
    expect(validateSourceManifest(remote).ok).toBe(false)
    const disk = local()
    disk.transport.directoryId = 'unknown-folder'
    expect(validateSourceManifest(disk).ok).toBe(false)
    disk.transport.directoryId = 'exports'
    disk.permissions.directories[0].path = '/Users/private'
    expect(validateSourceManifest(disk).ok).toBe(false)
  })
  it('accepts public HTTPS without credential slot', () => {
    const value = http()
    value.permissions.credentials = []
    delete value.transport.credentialId
    expect(validateSourceManifest(value).ok).toBe(true)
  })
  it.each([
    '../events.jsonl',
    '/tmp/events.jsonl',
    'C:\\data\\events.jsonl',
    '**/*.jsonl',
    'events.js',
    'nested/../events.jsonl',
  ])('rejects unsafe file declaration %s', (file) => {
    const value = local()
    value.transport.file = file
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it('rejects excess scopes, request rates, page counts and invalid sampling limits', () => {
    for (const override of [
      { requestsPerMinute: 61 },
      { maxResponseBytes: 2097153 },
      { maxPages: 21 },
    ]) {
      const value = http()
      Object.assign(value.transport, override)
      expect(validateSourceManifest(value).ok).toBe(false)
    }
    const value = http()
    value.permissions.directories = [{ id: 'exports', purpose: 'extra access' }]
    expect(validateSourceManifest(value).ok).toBe(false)
    value.permissions.directories = []
    value.sampling.intervalSeconds = 0
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it('requires cursor config for multiple pages and bounded local lines', () => {
    const remote = http()
    delete remote.transport.pagination
    expect(validateSourceManifest(remote).ok).toBe(false)
    remote.transport.maxPages = 1
    expect(validateSourceManifest(remote).ok).toBe(true)
    const disk = local()
    disk.transport.maxFileBytes = 1
    expect(validateSourceManifest(disk).ok).toBe(false)
  })
  it.each(['$.content', 'return body.content', '/bad~2escape', '/bad\nkey'])(
    'rejects non-pointer mapping %s',
    (pointer) => {
      const value = http()
      value.mapping.text.pointer = pointer
      expect(validateSourceManifest(value).ok).toBe(false)
    },
  )
  it('rejects unsupported target fields and invalid fixed roles', () => {
    const value = local()
    value.mapping.taskStatus = { constant: 'done' }
    expect(validateSourceManifest(value).ok).toBe(false)
    delete value.mapping.taskStatus
    value.mapping.role.constant = 'admin'
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it('uses the same SourceEvent target fields for the two sample declarations', () => {
    const input: Record<string, string> = {
      id: 'event-001',
      revision: 'r1',
      created_at: '2026-09-13T00:00:00Z',
      role: 'user',
      content: '合成测试事项',
    }
    for (const sample of [
      HTTP_JSON_MANIFEST_EXAMPLE,
      LOCAL_JSONL_MANIFEST_EXAMPLE,
    ]) {
      const mapped = Object.fromEntries(
        Object.entries(sample.mapping).map(([key, selector]) => [
          key,
          'pointer' in selector
            ? input[selector.pointer.slice(1)]
            : selector.constant,
        ]),
      )
      expect(
        parseSourceEvent({
          ...mapped,
          schemaVersion: 1,
          sourceInstanceId: 'test-instance',
        }),
      ).toMatchObject({
        externalId: 'event-001',
        revision: 'r1',
        text: '合成测试事项',
        role: 'user',
      })
    }
  })
  it('requires own JSON fields rather than inherited prototype properties', () => {
    expect(
      validateSourceManifest(Object.create(HTTP_JSON_MANIFEST_EXAMPLE)).ok,
    ).toBe(false)
  })
  it('parse fails with structured errors for unsupported data', () => {
    expect(() => parseSourceManifest({})).toThrow(InvalidSourceManifestError)
    for (const value of [null, [], 'manifest'])
      expect(validateSourceManifest(value).ok).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  HTTP_JSON_MANIFEST_EXAMPLE,
  validateSourceManifest,
  type SourceManifest,
} from '../../packages/plugin-host/src/manifest'
const manifest = (): Extract<SourceManifest, { kind: 'http-json' }> =>
  structuredClone(HTTP_JSON_MANIFEST_EXAMPLE) as unknown as Extract<
    SourceManifest,
    { kind: 'http-json' }
  >

describe('HTTP manifest canonical URL boundary', () => {
  it.each([
    'https://%61pi.example.com/events',
    'https://api%2eexample.com/events',
    'https://api.example.com\\events',
    'https:\\api.example.com/events',
    'https:///api.example.com/events',
    'https:api.example.com/events',
    ' https://api.example.com/events',
    'https://api.exa\tmple.com/events',
    'https://api.example.com/ev\nents',
    'https://api.example.com/ev\rents',
    'https://api.example.com/events?',
    'https://api.example.com/events#',
    'https://api.example.com/events?cursor=x',
    'https://@api.example.com/events',
    'https://name@api.example.com/events',
    'https://name:%70assword@api.example.com/events',
    'https://api.example.com.evil.example/events',
    'https://api.example.com./events',
    'https://api.example.com:0444/events',
    'https://api.example.com/events%',
    'https://api.example.com/events%2',
    'https://api.example.com/events%xx',
  ])('rejects ambiguous, credential-bearing or non-permitted URL %s', (url) => {
    const value = manifest()
    value.transport.url = url
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it.each([
    'https://api.example.com/events%20archive',
    'https://api.example.com/events%2Farchive',
    'https://api.example.com/%E4%BA%8B%E9%A1%B9',
    'https://api.example.com:443/events',
  ])('preserves legitimate encoded paths and HTTPS default port %s', (url) => {
    const value = manifest()
    value.transport.url = url
    expect(validateSourceManifest(value).ok).toBe(true)
  })
  it.each([
    'localhost',
    'api.localhost',
    'api.local',
    'localhost.localdomain',
    'router.home.arpa',
    '127.0.0.1',
    '127.1',
    '0x7f000001',
    '[::1]',
    '2130706433',
  ])('rejects explicitly local name or numeric declaration %s', (domain) => {
    const value = manifest()
    value.permissions.domains = [domain]
    value.transport.url = `https://${domain}/events`
    expect(validateSourceManifest(value).ok).toBe(false)
  })
})

describe('HTTP declaration and runtime agreement', () => {
  it('requires an exact named credential slot and refuses embedded secrets/headers', () => {
    const value = manifest()
    value.transport.credentialId = 'other-token'
    expect(validateSourceManifest(value).ok).toBe(false)
    value.transport.credentialId = 'api-token'
    expect(
      validateSourceManifest({
        ...value,
        transport: {
          ...value.transport,
          headers: { Authorization: 'Bearer do-not-export' },
        },
      }).ok,
    ).toBe(false)
    expect(
      validateSourceManifest({
        ...value,
        permissions: {
          ...value.permissions,
          credentials: [
            { id: 'api-token', purpose: 'read events', value: 'do-not-export' },
          ],
        },
      }).ok,
    ).toBe(false)
  })
  it.each([
    'cursor&token',
    'cursor=value',
    'cursor[]',
    '?cursor',
    'cursor\n',
    '__proto__',
  ])('rejects non-query-key pagination parameter %s', (cursorParameter) => {
    const value = manifest()
    value.transport.pagination!.cursorParameter = cursorParameter
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it('allows ordinary query keys without allowing static query values', () => {
    const value = manifest()
    value.transport.pagination!.cursorParameter = 'page_cursor2'
    expect(validateSourceManifest(value).ok).toBe(true)
    value.transport.url += '?page_cursor2=secret'
    expect(validateSourceManifest(value).ok).toBe(false)
  })
  it.each(['/__proto__/token', '/constructor/prototype', '/nested/prototype'])(
    'rejects dangerous pointer segments for records, cursors and mappings %s',
    (pointer) => {
      for (const target of ['records', 'cursor', 'mapping']) {
        const value = manifest()
        if (target === 'records') value.transport.recordsPointer = pointer
        else if (target === 'cursor')
          value.transport.pagination!.cursorPointer = pointer
        else value.mapping.text.pointer = pointer
        expect(validateSourceManifest(value).ok).toBe(false)
      }
    },
  )
  it('treats escaped slash and tilde as a single own-property key, not a path', () => {
    const value = manifest()
    value.mapping.text.pointer = '/data/a~1constructor/~0key'
    expect(validateSourceManifest(value).ok).toBe(true)
  })
  it('does not accept inherited required selectors or inherited optional permission declarations', () => {
    const inheritedMapping = manifest()
    inheritedMapping.mapping.text = Object.create({ pointer: '/content' })
    expect(validateSourceManifest(inheritedMapping).ok).toBe(false)
    const inheritedCredential = manifest()
    delete inheritedCredential.transport.credentialId
    Object.setPrototypeOf(inheritedCredential.transport, {
      credentialId: 'api-token',
    })
    expect(validateSourceManifest(inheritedCredential).ok).toBe(false)
    const inheritedPagination = manifest()
    delete inheritedPagination.transport.pagination
    Object.setPrototypeOf(inheritedPagination.transport, {
      pagination: { cursorPointer: '/next', cursorParameter: 'cursor' },
    })
    expect(validateSourceManifest(inheritedPagination).ok).toBe(false)
  })
})

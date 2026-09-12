import { describe, it, expect, vi } from 'vitest'
import { createHttpJsonReader } from '../../packages/plugin-host/src/http-json'
import { HTTP_JSON_MANIFEST_EXAMPLE } from '../../packages/plugin-host/src/manifest'
import type { HttpTransport } from '../../packages/plugin-host/src/http-transport'
const auth = {
  sourceInstanceId: 'host-source',
  domain: 'api.example.com',
  credential: { id: 'api-token', token: 'TEST_TOKEN' },
}
const item = (id = 'e1', role = 'user', content = '文本') => ({
  id,
  revision: '1',
  created_at: '2026-09-13T00:00:00Z',
  role,
  content,
  sourceInstanceId: 'spoofed',
})
const bytes = (items: unknown[], next_cursor: unknown = null) =>
  new TextEncoder().encode(JSON.stringify({ items, next_cursor }))
type Mutable<T> = T extends object
  ? { -readonly [K in keyof T]: Mutable<T[K]> }
  : T
const manifest = () =>
  structuredClone(HTTP_JSON_MANIFEST_EXAMPLE) as Mutable<
    typeof HTTP_JSON_MANIFEST_EXAMPLE
  >
describe('declarative HTTPS JSON reader', () => {
  it('injects host source, maps all roles and opaque cursors without execution', async () => {
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(
        bytes(
          [
            item('u'),
            item('a', 'assistant', '$(touch /tmp/no) <script>run()</script>'),
          ],
          'a&evil=https://bad.test/#',
        ),
      )
      .mockResolvedValueOnce(bytes([item('t', 'tool'), item('s', 'system')]))
    const reader = createHttpJsonReader({
      manifest: manifest(),
      authorization: auth,
      transport,
    })
    const result = await reader.read()
    expect(result.events.map((e) => e.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'system',
    ])
    expect(
      result.events.every((e) => e.sourceInstanceId === 'host-source'),
    ).toBe(true)
    expect(result.events[1]?.text).toBe(
      '$(touch /tmp/no) <script>run()</script>',
    )
    expect(
      new URL(transport.mock.calls[1]![0].url).searchParams.get('cursor'),
    ).toBe('a&evil=https://bad.test/#')
    expect(transport.mock.calls[0]![0]).toMatchObject({
      allowedDomain: 'api.example.com',
      bearerToken: 'TEST_TOKEN',
      timeoutMs: 15000,
    })
    expect(JSON.stringify(result.cursor)).not.toContain('TEST_TOKEN')
    expect(result.done).toBe(true)
    expect(result.pagesRead).toBe(2)
    expect((await reader.read({ cursor: result.cursor })).events).toEqual([])
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid manifest, domain and credential before any request', () => {
    const transport = vi.fn<HttpTransport>()
    expect(() =>
      createHttpJsonReader({
        manifest: { ...manifest(), command: 'shell' },
        authorization: auth,
        transport,
      }),
    ).toThrow('INVALID_MANIFEST')
    for (const authorization of [
      { ...auth, domain: 'bad.test' },
      { ...auth, credential: { id: 'wrong', token: 'x' } },
      { ...auth, credential: undefined },
      { ...auth, credential: { id: 'api-token', token: 'a\r\nB' } },
    ])
      expect(() =>
        createHttpJsonReader({
          manifest: manifest(),
          authorization,
          transport,
        }),
      ).toThrow('UNAUTHORIZED_SOURCE')
    expect(transport).not.toHaveBeenCalled()
  })
  it('supports public endpoints but never injects an undeclared credential', async () => {
    const config = manifest() as any
    config.permissions.credentials = []
    delete config.transport.credentialId
    const transport = vi.fn<HttpTransport>().mockResolvedValue(bytes([]))
    const reader = createHttpJsonReader({
      manifest: config,
      authorization: {
        sourceInstanceId: auth.sourceInstanceId,
        domain: auth.domain,
      },
      transport,
    })
    await reader.read()
    expect(transport.mock.calls[0]![0]).not.toHaveProperty('bearerToken')
    expect(() =>
      createHttpJsonReader({
        manifest: config,
        authorization: auth,
        transport,
      }),
    ).toThrow('UNAUTHORIZED_SOURCE')
    expect(() =>
      createHttpJsonReader({
        manifest: config,
        authorization: { ...auth, credential: { token: 'unexpected' } as any },
        transport,
      }),
    ).toThrow('UNAUTHORIZED_SOURCE')
  })
  it('caps maxPages and resumes at the next complete page', async () => {
    const config = manifest()
    config.transport.maxPages = 1 as 5
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(bytes([item()], 'next'))
      .mockResolvedValueOnce(bytes([item('two')]))
    const reader = createHttpJsonReader({
      manifest: config,
      authorization: auth,
      transport,
    })
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(first.cursor.next).toBe('next')
    const last = await reader.read({ cursor: first.cursor })
    expect(last.events[0]?.externalId).toBe('two')
  })
  it('keeps oversized later page unacknowledged and re-reads it next run', async () => {
    const config = manifest()
    config.sampling.maxRecordsPerRun = 2 as 100
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(bytes([item()], 'page2'))
      .mockResolvedValueOnce(bytes([item('2'), item('3')]))
      .mockResolvedValueOnce(bytes([item('2'), item('3')]))
    const reader = createHttpJsonReader({
      manifest: config,
      authorization: auth,
      transport,
    })
    const first = await reader.read()
    expect(first.events).toHaveLength(1)
    expect(first.cursor.next).toBe('page2')
    expect(first.pagesRead).toBe(1)
    const next = await reader.read({ cursor: first.cursor })
    expect(next.events).toHaveLength(2)
    expect(transport.mock.calls[1]![0].url).toBe(
      transport.mock.calls[2]![0].url,
    )
  })
  it('rejects an oversized first page instead of skipping records', async () => {
    const config = manifest()
    config.sampling.maxRecordsPerRun = 1 as 100
    const reader = createHttpJsonReader({
      manifest: config,
      authorization: auth,
      transport: async () => bytes([item(), item('two')]),
    })
    await expect(reader.read()).rejects.toThrow('PAGE_LIMIT_EXCEEDED')
  })
  it('limits requests across calls and returns a resumable complete-page cursor', async () => {
    const config = manifest()
    config.transport.requestsPerMinute = 1 as 12
    let time = 0
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(bytes([item()], 'next'))
      .mockResolvedValue(bytes([item('next')]))
    const reader = createHttpJsonReader({
      manifest: config,
      authorization: auth,
      transport,
      now: () => time,
    })
    const first = await reader.read()
    expect(first.cursor.next).toBe('next')
    await expect(reader.read({ cursor: first.cursor })).rejects.toThrow(
      'RATE_LIMITED',
    )
    time = 60000
    expect((await reader.read({ cursor: first.cursor })).done).toBe(true)
  })
  it('rejects repeated cursors within and across runs', async () => {
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(bytes([], 'x'))
      .mockResolvedValueOnce(bytes([], 'x'))
    await expect(
      createHttpJsonReader({
        manifest: manifest(),
        authorization: auth,
        transport,
      }).read(),
    ).rejects.toThrow('PAGINATION_LOOP')
    const config = manifest()
    config.transport.maxPages = 1 as 5
    const t = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(bytes([], 'x'))
      .mockResolvedValueOnce(bytes([], 'y'))
      .mockResolvedValueOnce(bytes([], 'x'))
    const reader = createHttpJsonReader({
      manifest: config,
      authorization: auth,
      transport: t,
    })
    const a = await reader.read()
    const b = await reader.read({ cursor: a.cursor })
    await expect(reader.read({ cursor: b.cursor })).rejects.toThrow(
      'PAGINATION_LOOP',
    )
  })
  it('binds cursor to source and manifest', async () => {
    const config = manifest()
    config.transport.maxPages = 1 as 5
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValue(bytes([], 'next'))
    const cursor = (
      await createHttpJsonReader({
        manifest: config,
        authorization: auth,
        transport,
      }).read()
    ).cursor
    const other = createHttpJsonReader({
      manifest: config,
      authorization: { ...auth, sourceInstanceId: 'other' },
      transport,
    })
    await expect(other.read({ cursor })).rejects.toThrow('INVALID_CURSOR')
    const changed = structuredClone(config)
    changed.mapping.text.pointer = '/changed' as '/content'
    await expect(
      createHttpJsonReader({
        manifest: changed,
        authorization: auth,
        transport,
      }).read({ cursor }),
    ).rejects.toThrow('INVALID_CURSOR')
  })
  it.each([
    ['invalid-json', new TextEncoder().encode('{')],
    ['invalid-utf8', new Uint8Array([0xff])],
    ['records', new TextEncoder().encode('{"items":{},"next_cursor":null}')],
    ['role', bytes([item('e', 'admin')])],
    ['date', bytes([{ ...item(), created_at: '2026-02-30T00:00:00Z' }])],
    ['next-number', bytes([], 42)],
    ['next-object', bytes([], { url: 'https://bad.test' })],
  ])('rejects malformed %s', async (_name, payload) => {
    await expect(
      createHttpJsonReader({
        manifest: manifest(),
        authorization: auth,
        transport: async () => payload,
      }).read(),
    ).rejects.toThrow()
  })
  it('rejects a partial second page without returning first-page events', async () => {
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(bytes([item()], 'next'))
      .mockResolvedValueOnce(bytes([item('okay'), { invalid: true }]))
    await expect(
      createHttpJsonReader({
        manifest: manifest(),
        authorization: auth,
        transport,
      }).read(),
    ).rejects.toThrow('INVALID_SOURCE_EVENT')
  })
  it('enforces response byte limits even with an injected transport', async () => {
    const config = manifest()
    config.transport.maxResponseBytes = 4 as 1048576
    await expect(
      createHttpJsonReader({
        manifest: config,
        authorization: auth,
        transport: async () => bytes([]),
      }).read(),
    ).rejects.toThrow('RESPONSE_TOO_LARGE')
  })
  it('cancels before network and after in-flight response without returning data', async () => {
    const controller = new AbortController()
    const transport = vi.fn<HttpTransport>().mockImplementation(async () => {
      controller.abort()
      return bytes([item()])
    })
    const reader = createHttpJsonReader({
      manifest: manifest(),
      authorization: auth,
      transport,
    })
    await expect(reader.read({ signal: controller.signal })).rejects.toThrow(
      'CANCELLED',
    )
    await expect(reader.read({ signal: controller.signal })).rejects.toThrow(
      'CANCELLED',
    )
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('redacts arbitrary transport failure details and never returns earlier pages', async () => {
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(bytes([item()], 'next'))
      .mockRejectedValueOnce(new Error('SECRET_TOKEN https://private'))
    await expect(
      createHttpJsonReader({
        manifest: manifest(),
        authorization: auth,
        transport,
      }).read(),
    ).rejects.toMatchObject({ message: 'TRANSPORT_FAILED' })
  })
  it('rejects overlapping reads on the same rate-limited reader', async () => {
    let finish!: (value: Uint8Array) => void
    const transport: HttpTransport = () =>
      new Promise((resolve) => {
        finish = resolve
      })
    const reader = createHttpJsonReader({
      manifest: manifest(),
      authorization: auth,
      transport,
    })
    const first = reader.read()
    await expect(reader.read()).rejects.toThrow('READER_BUSY')
    finish(bytes([]))
    await first
  })
  it('caps aggregate text at 4 MiB and leaves the next whole page resumable', async () => {
    const config = manifest()
    config.transport.maxResponseBytes = 2097152 as 1048576
    let number = 0
    const transport = vi.fn<HttpTransport>().mockImplementation(async () => {
      number++
      return bytes(
        Array.from({ length: 20 }, (_, i) =>
          item(`${number}-${i}`, 'user', 'x'.repeat(65536)),
        ),
        `page${number + 1}`,
      )
    })
    const result = await createHttpJsonReader({
      manifest: config,
      authorization: auth,
      transport,
    }).read()
    expect(result.events).toHaveLength(60)
    expect(result.pagesRead).toBe(3)
    expect(result.cursor.next).toBe('page4')
  })
  it('caps events at 500 even when manifest requests 1000', async () => {
    const config = manifest()
    config.sampling.maxRecordsPerRun = 1000 as 100
    await expect(
      createHttpJsonReader({
        manifest: config,
        authorization: auth,
        transport: async () =>
          bytes(Array.from({ length: 501 }, (_, i) => item(String(i)))),
      }).read(),
    ).rejects.toThrow('PAGE_LIMIT_EXCEEDED')
  })
  it('maps escaped own JSON pointers and a declared constant role', async () => {
    const config = manifest() as any
    config.mapping.text = { pointer: '/a~1b/~0text' }
    config.mapping.role = { constant: 'tool' }
    const result = await createHttpJsonReader({
      manifest: config,
      authorization: auth,
      transport: async () =>
        bytes([{ ...item(), 'a/b': { '~text': 'escaped' } }]),
    }).read()
    expect(result.events[0]?.text).toBe('escaped')
    expect(result.events[0]?.role).toBe('tool')
  })
  it.each(['delete', 'replace'] as const)(
    'retains the original abort signal when caller %s changes read options',
    async (operation) => {
      const controller = new AbortController()
      const options: { signal?: AbortSignal } = { signal: controller.signal }
      let resolveResponse!: (response: Uint8Array) => void
      const transport = vi.fn<HttpTransport>().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveResponse = resolve
          }),
      )
      const reader = createHttpJsonReader({
        manifest: manifest(),
        authorization: auth,
        transport,
      })
      const pending = reader.read(options)
      expect(transport.mock.calls[0]![0].signal).toBe(controller.signal)
      if (operation === 'delete') delete options.signal
      else options.signal = new AbortController().signal
      controller.abort()
      resolveResponse(bytes([item()]))
      await expect(pending).rejects.toThrow('CANCELLED')
      expect(transport).toHaveBeenCalledTimes(1)
    },
  )
})

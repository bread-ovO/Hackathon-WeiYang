import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import {
  requestHttpsResponse,
  requestHttpsJson,
} from '../../packages/plugin-host/src/http-transport'
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }))
vi.mock('node:https', () => ({ request: mocks.request }))
let req: EventEmitter & {
  destroy: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}
let res: EventEmitter & {
  destroy: ReturnType<typeof vi.fn>
  statusCode: number
  headers: Record<string, string>
  complete: boolean
}
let callback: (response: typeof res) => void
const input = () => ({
  url: 'https://api.example.com/events',
  allowedDomain: 'api.example.com',
  maxResponseBytes: 32,
  timeoutMs: 100,
})
async function response(status: number, headers: Record<string, string> = {}) {
  await Promise.resolve()
  await Promise.resolve()
  res.statusCode = status
  res.headers = headers
  callback(res)
}
function end(body = '') {
  if (body) res.emit('data', Buffer.from(body))
  res.complete = true
  res.emit('end')
}
beforeEach(() => {
  mocks.lookup
    .mockReset()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  req = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() })
  res = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    statusCode: 200,
    headers: {},
    complete: false,
  })
  mocks.request.mockReset().mockImplementation((_options, cb) => {
    callback = cb
    return req
  })
})
afterEach(() => vi.useRealTimers())
describe('shared constrained HTTPS response', () => {
  it('returns only allowlisted lowercase response headers and bytes', async () => {
    const pending = requestHttpsResponse({
      ...input(),
      headers: {
        Accept: 'application/vnd.github+json',
        'If-None-Match': '"tag"',
        'If-Modified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      bearerToken: 'TOKEN',
    })
    await response(200, {
      'content-type': 'application/json',
      etag: '"tag"',
      link: '<https://api.example.com/events?page=2>; rel="next"',
      'retry-after': '3',
      'x-ratelimit-reset': '100',
      'x-ratelimit-remaining': '0',
      'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
      'set-cookie': 'PRIVATE',
      'x-secret': 'PRIVATE',
    })
    end('{}')
    const result = await pending
    expect(result.status).toBe(200)
    expect(Buffer.from(result.bytes).toString()).toBe('{}')
    expect(Object.keys(result.headers).sort()).toEqual([
      'content-type',
      'etag',
      'last-modified',
      'link',
      'retry-after',
      'x-ratelimit-remaining',
      'x-ratelimit-reset',
    ])
    const options = mocks.request.mock.calls[0]![0]
    expect(options.headers).toMatchObject({
      'If-None-Match': '"tag"',
      Authorization: 'Bearer TOKEN',
      Accept: 'application/vnd.github+json',
      'Accept-Encoding': 'identity',
    })
    expect(options).toMatchObject({
      agent: false,
      rejectUnauthorized: true,
      servername: 'api.example.com',
    })
  })
  it('permits empty 304 without content-type even if entity length exceeds body limit', async () => {
    const pending = requestHttpsResponse(input())
    await response(304, { 'content-length': '99999999', etag: '"cache"' })
    end()
    const result = await pending
    expect(result.bytes.byteLength).toBe(0)
    expect(result).toMatchObject({
      status: 304,
      headers: { etag: '"cache"' },
    })
  })
  it('rejects actual bytes in a 304 response', async () => {
    const pending = requestHttpsResponse(input())
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'HTTP_RESPONSE_INVALID',
    })
    await response(304)
    end('x')
    await rejection
    expect(req.destroy).toHaveBeenCalled()
  })
  it.each([401, 403, 404, 429])(
    'passes %s status and bounded HTML error body for adapter interpretation',
    async (status) => {
      const pending = requestHttpsResponse(input())
      await response(status, {
        'content-type': 'text/html',
        'retry-after': '120',
      })
      end('<p>limit</p>')
      const result = await pending
      expect(result.status).toBe(status)
      expect(result.headers['retry-after']).toBe('120')
      expect(Buffer.from(result.bytes).toString()).toBe('<p>limit</p>')
    },
  )
  it.each([301, 302, 303, 307, 308])(
    'rejects redirect %s without a second request',
    async (status) => {
      const pending = requestHttpsResponse({ ...input(), bearerToken: 'TOKEN' })
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'HTTP_REDIRECT_DENIED',
      })
      await response(status, { location: 'https://other.example' })
      await rejection
      expect(mocks.request).toHaveBeenCalledTimes(1)
    },
  )
  it.each([
    'Host',
    'Authorization',
    'Cookie',
    'Connection',
    'Accept-Encoding',
    'constructor',
    '__proto__',
  ])('rejects nonallowlisted header %s before DNS', async (key) => {
    const headers = Object.fromEntries([[key, 'forbidden']])
    await expect(
      requestHttpsResponse({
        ...input(),
        headers: headers as unknown as Record<string, string>,
      }),
    ).rejects.toMatchObject({ code: 'HTTP_INVALID_REQUEST' })
    expect(mocks.lookup).not.toHaveBeenCalled()
  })
  it.each([
    { Accept: 'application/json', accept: 'text/plain' },
    { 'If-None-Match': 'x\r\nHost: attacker' },
    { 'If-None-Match': 'x'.repeat(2049) },
    { Accept: '\u0000' },
  ])(
    'rejects ambiguous, injected or oversized request headers',
    async (headers) => {
      await expect(
        requestHttpsResponse({
          ...input(),
          headers: headers as unknown as Record<string, string>,
        }),
      ).rejects.toMatchObject({ code: 'HTTP_INVALID_REQUEST' })
      expect(mocks.lookup).not.toHaveBeenCalled()
    },
  )
  it('captures headers before asynchronous DNS yields', async () => {
    let finish!: (value: { address: string; family: number }[]) => void
    mocks.lookup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const headers = { 'If-None-Match': '"original"' }
    const options = { ...input(), headers }
    const pending = requestHttpsResponse(options)
    headers['If-None-Match'] = '"changed"'
    options.headers = { 'If-None-Match': '"replacement"' }
    finish([{ address: '93.184.216.34', family: 4 }])
    await response(304)
    end()
    await pending
    expect(mocks.request.mock.calls[0]![0].headers['If-None-Match']).toBe(
      '"original"',
    )
  })
  it.each([200, 403, 429])(
    'bounds actual byte count for %s',
    async (status) => {
      const pending = requestHttpsResponse(input())
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'HTTP_LIMIT_EXCEEDED',
      })
      await response(status, { 'content-type': 'application/json' })
      end('x'.repeat(33))
      await rejection
    },
  )
  it.each([401, 403, 404, 429])(
    'rejects compressed error bodies for %s',
    async (status) => {
      const pending = requestHttpsResponse(input())
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'HTTP_RESPONSE_INVALID',
      })
      await response(status, { 'content-encoding': 'gzip' })
      await rejection
    },
  )
  it('still rejects non-JSON success and oversized projected response headers', async () => {
    let pending = requestHttpsResponse(input())
    let rejection = expect(pending).rejects.toMatchObject({
      code: 'HTTP_RESPONSE_INVALID',
    })
    await response(200, { 'content-type': 'text/html' })
    await rejection
    pending = requestHttpsResponse(input())
    rejection = expect(pending).rejects.toMatchObject({
      code: 'HTTP_RESPONSE_INVALID',
    })
    await response(200, {
      'content-type': 'application/json',
      etag: 'x'.repeat(8193),
    })
    await rejection
  })
  it.each([304, 403, 429])(
    'keeps legacy JSON-only status rejection for %s',
    async (status) => {
      const pending = requestHttpsJson(input())
      const rejection = expect(pending).rejects.toMatchObject({
        code: status === 304 ? 'HTTP_REDIRECT_DENIED' : 'HTTP_RESPONSE_INVALID',
      })
      await response(status, { 'content-type': 'application/json' })
      await rejection
    },
  )
})

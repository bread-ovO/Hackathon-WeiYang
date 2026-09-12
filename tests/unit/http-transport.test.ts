import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { requestHttpsJson } from '../../packages/plugin-host/src/http-transport'
import { isPublicAddress } from '../../packages/plugin-host/src/network-address'
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
  url: 'https://api.example.com/events?cursor=1',
  allowedDomain: 'api.example.com',
  timeoutMs: 100,
  maxResponseBytes: 32,
})
async function respond(
  status = 200,
  headers: Record<string, string> = { 'content-type': 'application/json' },
) {
  await Promise.resolve()
  await Promise.resolve()
  res.statusCode = status
  res.headers = headers
  callback(res)
}
function end(text = '{}') {
  res.emit('data', Buffer.from(text))
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
describe('public network address policy', () => {
  it.each([
    '0.1.2.3',
    '10.1.2.3',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.9',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.1.1',
    '198.19.1.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '64:ff9b::808:808',
    '2001::1',
    '2001:2::1',
    '2001:db8::1',
    '2002:808:808::1',
    '3fff::1',
    'fe80::1%eth0',
    'garbage',
  ])('rejects %s', (ip) => expect(isPublicAddress(ip)).toBe(false))
  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '100.128.0.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ])('accepts %s', (ip) => expect(isPublicAddress(ip)).toBe(true))
})
describe('HTTPS JSON transport', () => {
  it('pins validated DNS, retains TLS hostname, and never uses proxy/pooling', async () => {
    const result = requestHttpsJson({ ...input(), bearerToken: 'secret' })
    await respond()
    end()
    expect(Buffer.from(await result).toString()).toBe('{}')
    const options = mocks.request.mock.calls[0]![0] as RequestOptions
    expect(options).toMatchObject({
      hostname: 'api.example.com',
      servername: 'api.example.com',
      port: 443,
      agent: false,
      rejectUnauthorized: true,
      path: '/events?cursor=1',
      headers: {
        Authorization: 'Bearer secret',
        'Accept-Encoding': 'identity',
        'User-Agent': 'BUGU/0.1 (declarative-source)',
      },
    })
    const cb = vi.fn()
    options.lookup!('api.example.com', {}, cb)
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4)
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
  })
  it.each([
    'http://api.example.com/x',
    'https://api.example.com:444/x',
    'https://user@api.example.com/x',
    'https://@api.example.com/x',
    'https://api.example.com/x#',
    'https://other.example.com/x',
    'https://api.example.com\\x',
    'https://api.example.com/%XX',
    'https://%61pi.example.com/x',
    ' https://api.example.com/x',
  ])('rejects malformed/unauthorized URL %s', async (url) => {
    await expect(requestHttpsJson({ ...input(), url })).rejects.toMatchObject({
      code: 'HTTP_INVALID_REQUEST',
    })
    expect(mocks.lookup).not.toHaveBeenCalled()
  })
  it('rejects mixed public/private DNS before connecting', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(requestHttpsJson(input())).rejects.toMatchObject({
      code: 'HTTP_ADDRESS_DENIED',
    })
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('rejects redirects without forwarding credentials', async () => {
    const result = requestHttpsJson({ ...input(), bearerToken: 'secret' })
    await respond(302, {
      'content-type': 'application/json',
      location: 'https://other.example/secret',
    })
    await expect(result).rejects.toMatchObject({
      code: 'HTTP_REDIRECT_DENIED',
      message: 'HTTP_REDIRECT_DENIED',
    })
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(req.destroy).toHaveBeenCalled()
  })
  it.each([
    { 'content-type': 'text/html' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
  ])('rejects incompatible response %j', async (headers) => {
    const result = requestHttpsJson(input())
    await respond(200, headers as Record<string, string>)
    await expect(result).rejects.toMatchObject({
      code: 'HTTP_RESPONSE_INVALID',
    })
  })
  it('enforces actual streamed byte size without Content-Length', async () => {
    const result = requestHttpsJson(input())
    await respond()
    res.emit('data', Buffer.alloc(20))
    res.emit('data', Buffer.alloc(20))
    await expect(result).rejects.toMatchObject({ code: 'HTTP_LIMIT_EXCEEDED' })
    expect(res.destroy).toHaveBeenCalled()
  })
  it('rejects oversized declared response before data', async () => {
    const result = requestHttpsJson(input())
    await respond(200, {
      'content-type': 'application/json',
      'content-length': '99999',
    })
    await expect(result).rejects.toMatchObject({ code: 'HTTP_LIMIT_EXCEEDED' })
  })
  it('total deadline covers DNS and late DNS cannot connect', async () => {
    vi.useFakeTimers()
    let complete!: (value: unknown) => void
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const result = requestHttpsJson(input())
    const assertion = expect(result).rejects.toMatchObject({
      code: 'HTTP_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(101)
    await assertion
    complete([{ address: '8.8.8.8', family: 4 }])
    await Promise.resolve()
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('slow trickle does not reset total deadline', async () => {
    vi.useFakeTimers()
    const result = requestHttpsJson(input())
    const assertion = expect(result).rejects.toMatchObject({
      code: 'HTTP_TIMEOUT',
    })
    await respond()
    await vi.advanceTimersByTimeAsync(60)
    res.emit('data', Buffer.from('a'))
    await vi.advanceTimersByTimeAsync(41)
    await assertion
    expect(req.destroy).toHaveBeenCalled()
  })
  it('cancellation destroys active request and response', async () => {
    const controller = new AbortController()
    const result = requestHttpsJson({ ...input(), signal: controller.signal })
    await respond()
    controller.abort('secret url')
    await expect(result).rejects.toMatchObject({
      code: 'HTTP_CANCELLED',
      message: 'HTTP_CANCELLED',
    })
    expect(req.destroy).toHaveBeenCalled()
    expect(res.destroy).toHaveBeenCalled()
  })
  it('pins public IPv6 with both lookup callback forms', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '2606:4700:4700::1111', family: 6 },
    ])
    const result = requestHttpsJson(input())
    await respond()
    end()
    await result
    const options = mocks.request.mock.calls[0]![0] as RequestOptions
    const cb = vi.fn()
    options.lookup!('api.example.com', { all: true }, cb)
    expect(cb).toHaveBeenCalledWith(
      null,
      [{ address: '2606:4700:4700::1111', family: 6 }],
      6,
    )
  })
  it('rejects premature response close and never returns partial bytes', async () => {
    const result = requestHttpsJson(input())
    await respond()
    res.emit('data', Buffer.from('{'))
    res.emit('close')
    await expect(result).rejects.toMatchObject({ code: 'HTTP_REQUEST_FAILED' })
  })
  it('rejects pre-cancellation before DNS and token header injection', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      requestHttpsJson({ ...input(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'HTTP_CANCELLED' })
    await expect(
      requestHttpsJson({ ...input(), bearerToken: 'secret\r\nHost: local' }),
    ).rejects.toMatchObject({ code: 'HTTP_INVALID_REQUEST' })
    expect(mocks.lookup).not.toHaveBeenCalled()
  })
  it('snapshots authorization and limits while DNS is pending', async () => {
    let complete!: (value: unknown) => void
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const mutable = { ...input(), bearerToken: 'initial-secret' }
    const result = requestHttpsJson(mutable)
    mutable.url = 'https://other.example.com/changed'
    mutable.allowedDomain = 'other.example.com'
    mutable.bearerToken = 'changed\r\nHost: private'
    mutable.maxResponseBytes = 9999
    mutable.timeoutMs = 9999
    complete([{ address: '8.8.8.8', family: 4 }])
    await respond()
    expect(mocks.request.mock.calls[0]![0]).toMatchObject({
      hostname: 'api.example.com',
      path: '/events?cursor=1',
      headers: { Authorization: 'Bearer initial-secret' },
    })
    res.emit('data', Buffer.alloc(33))
    await expect(result).rejects.toMatchObject({ code: 'HTTP_LIMIT_EXCEEDED' })
  })
  it('retains the original abort signal after caller replaces it', async () => {
    let complete!: (value: unknown) => void
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const original = new AbortController()
    const replacement = new AbortController()
    const cleanup = vi.spyOn(original.signal, 'removeEventListener')
    const mutable = { ...input(), signal: original.signal }
    const result = requestHttpsJson(mutable)
    mutable.signal = replacement.signal
    complete([{ address: '8.8.8.8', family: 4 }])
    await respond()
    original.abort()
    await expect(result).rejects.toMatchObject({ code: 'HTTP_CANCELLED' })
    expect(req.destroy).toHaveBeenCalled()
    expect(res.destroy).toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(replacement.signal.aborted).toBe(false)
  })
  it('sanitizes DNS and TLS errors', async () => {
    mocks.lookup.mockRejectedValue(new Error('secret private path'))
    await expect(requestHttpsJson(input())).rejects.toMatchObject({
      message: 'HTTP_REQUEST_FAILED',
    })
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const result = requestHttpsJson(input())
    await Promise.resolve()
    await Promise.resolve()
    req.emit('error', new Error('secret token'))
    await expect(result).rejects.toMatchObject({
      message: 'HTTP_REQUEST_FAILED',
    })
  })
})

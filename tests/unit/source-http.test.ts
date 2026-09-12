import { describe, expect, it, vi } from 'vitest'
import type { SourceHttpTransport } from '../../packages/connectors/src/http-client'
import {
  createSourceHttpTransport,
  SourceHttpError,
} from '../../apps/desktop/src/main/source-http'
import type {
  HttpsResponse,
  HttpsResponseInput,
} from '../../packages/plugin-host/src/http-transport'
const input = () => ({
  url: 'https://api.github.com/repos/a/b/pulls',
  allowedDomain: 'api.github.com',
  bearerToken: 'private-token',
  signal: new AbortController().signal,
})
const response = (patch: Partial<HttpsResponse> = {}): HttpsResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  bytes: Buffer.from('{"ok":true}'),
  ...patch,
})

describe('host source HTTP capability', () => {
  it('fixes transport bounds and projects response headers', async () => {
    const raw = response({
      headers: {
        'Content-Type': 'application/vnd.github+json',
        ETag: '"a"',
        Link: '<https://api.github.com/repos/a/b/pulls?page=2>; rel="next"',
        'set-cookie': 'secret-cookie',
        authorization: 'private-token',
        'x-internal': 'private',
      },
    })
    const transport = vi.fn(async (request: HttpsResponseInput) => {
      expect(request).toMatchObject({
        timeoutMs: 15000,
        maxResponseBytes: 8 * 1024 * 1024,
      })
      return raw
    })
    const actual = await createSourceHttpTransport(transport)(input())
    expect(actual).toEqual({
      status: 200,
      headers: {
        'content-type': 'application/vnd.github+json',
        etag: '"a"',
        link: '<https://api.github.com/repos/a/b/pulls?page=2>; rel="next"',
      },
      body: { ok: true },
    })
    raw.bytes.fill(0)
    raw.headers.ETag = 'changed'
    expect(actual.body).toEqual({ ok: true })
    expect(actual.headers.etag).toBe('"a"')
  })
  it('snapshots caller options and headers before awaiting', async () => {
    let resolve!: (r: HttpsResponse) => void
    let captured!: HttpsResponseInput
    const transport = createSourceHttpTransport(async (request) => {
      captured = request
      return new Promise((r) => {
        resolve = r
      })
    })
    const request = { ...input(), headers: { Accept: 'application/json' } }
    const pending = transport(request)
    request.url = 'https://attacker.example/'
    request.bearerToken = 'changed'
    request.headers.Accept = 'text/html'
    expect(captured.url).toBe('https://api.github.com/repos/a/b/pulls')
    expect(captured.bearerToken).toBe('private-token')
    expect(captured.headers?.Accept).toBe('application/json')
    resolve(response())
    await pending
  })
  it.each([304, 403, 429])(
    'never returns error or conditional body for %s',
    async (status) => {
      const actual = await createSourceHttpTransport(async () =>
        response({
          status,
          bytes: Buffer.from('secret-error-not-json'),
          headers: {
            'retry-after': '10',
            'x-ratelimit-remaining': '0',
            'set-cookie': 'secret',
          },
        }),
      )(input())
      expect(actual).toEqual({
        status,
        headers: { 'retry-after': '10', 'x-ratelimit-remaining': '0' },
        body: null,
      })
    },
  )
  it.each([201, 202])(
    'parses other successful JSON statuses %s',
    async (status) => {
      expect(
        (
          await createSourceHttpTransport(async () => response({ status }))(
            input(),
          )
        ).body,
      ).toEqual({ ok: true })
    },
  )
  it.each([301, 302, 400, 401, 500])(
    'rejects unexpected status %s with a fixed error',
    async (status) => {
      await expect(
        createSourceHttpTransport(async () => response({ status }))(input()),
      ).rejects.toThrow('SOURCE_HTTP_FAILED')
    },
  )
  it.each([
    { allowedDomain: 'attacker.example', url: 'https://attacker.example/' },
    { url: 'https://open.feishu.cn/' },
    { url: 'https://api.github.com.evil.example/' },
    { url: 'https://user@api.github.com/' },
    { url: 'https://api.github.com:444/' },
    { url: 'https://%61pi.github.com/' },
    { url: 'https://api.github.com/\\evil' },
    { url: 'http://api.github.com/' },
    { url: 'https://api.github.com/#secret' },
    { url: 'https://api.github.com/?token=private-token' },
    { url: 'https://api.github.com/?token=private%2Dtoken' },
    { headers: { Authorization: 'forged' } },
    { headers: { Host: 'evil' } },
    { headers: { Accept: 'application/json\r\nX-Secret: value' } },
    { headers: { Accept: 'application/json', accept: 'text/html' } },
    { bearerToken: 'token\nInjected' },
  ])('rejects unauthorized request fields before transport', async (patch) => {
    const transport = vi.fn(async () => response())
    await expect(
      createSourceHttpTransport(transport)({
        ...input(),
        ...patch,
      } as Parameters<SourceHttpTransport>[0]),
    ).rejects.toThrow('SOURCE_HTTP_INVALID_REQUEST')
    expect(transport).not.toHaveBeenCalled()
  })
  it('permits Feishu and all approved conditional request headers', async () => {
    const transport = createSourceHttpTransport(async () => response())
    await expect(
      transport({
        ...input(),
        allowedDomain: 'open.feishu.cn',
        url: 'https://open.feishu.cn/open-apis/im/v1/messages',
        headers: {
          Accept: 'application/json',
          'If-None-Match': '"a"',
          'If-Modified-Since': 'Tue, 01 Sep 2026 00:00:00 GMT',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }),
    ).resolves.toMatchObject({ status: 200 })
  })
  it.each([
    { bytes: Uint8Array.from([0xc3, 0x28]) },
    { bytes: Buffer.from('not json') },
    { headers: { 'content-type': 'text/html' } },
    { headers: {} },
    { headers: { 'content-type': 'application/json', etag: 'a\r\nb' } },
    { headers: { 'content-type': 'application/json', ETag: 'a', etag: 'b' } },
  ])('rejects malformed successful JSON responses', async (patch) => {
    await expect(
      createSourceHttpTransport(async () =>
        response(patch as Partial<HttpsResponse>),
      )(input()),
    ).rejects.toThrow('SOURCE_HTTP_INVALID_RESPONSE')
  })
  it('enforces response byte limits on injected transports too', async () => {
    await expect(
      createSourceHttpTransport(async () =>
        response({ bytes: new Uint8Array(8 * 1024 * 1024 + 1) }),
      )(input()),
    ).rejects.toThrow('SOURCE_HTTP_LIMIT_EXCEEDED')
  })
  it('redacts arbitrary transport errors and preserves only fixed categories', async () => {
    for (const [code, expected] of [
      [undefined, 'SOURCE_HTTP_FAILED'],
      ['HTTP_TIMEOUT', 'SOURCE_HTTP_TIMEOUT'],
      ['HTTP_LIMIT_EXCEEDED', 'SOURCE_HTTP_LIMIT_EXCEEDED'],
    ]) {
      const promise = createSourceHttpTransport(async () => {
        throw Object.assign(new Error('private-token /private/file'), { code })
      })(input())
      await expect(promise).rejects.toBeInstanceOf(SourceHttpError)
      await expect(promise).rejects.toThrow(expected)
    }
  })
  it('rejects cancellation before and after transport', async () => {
    const controller = new AbortController()
    const transport = vi.fn(async () => {
      controller.abort()
      return response()
    })
    const send = createSourceHttpTransport(transport)
    await expect(
      send({ ...input(), signal: controller.signal }),
    ).rejects.toThrow('SOURCE_HTTP_CANCELLED')
    await expect(
      send({ ...input(), signal: controller.signal }),
    ).rejects.toThrow('SOURCE_HTTP_CANCELLED')
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

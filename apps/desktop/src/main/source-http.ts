import type { SourceHttpTransport } from '@memo/connectors'
import {
  requestHttpsResponse,
  type HttpsResponseInput,
  type HttpsResponse,
} from '@memo/plugin-host'

export type SourceHttpErrorCode =
  | 'SOURCE_HTTP_INVALID_REQUEST'
  | 'SOURCE_HTTP_FAILED'
  | 'SOURCE_HTTP_CANCELLED'
  | 'SOURCE_HTTP_TIMEOUT'
  | 'SOURCE_HTTP_LIMIT_EXCEEDED'
  | 'SOURCE_HTTP_INVALID_RESPONSE'
export class SourceHttpError extends Error {
  constructor(readonly code: SourceHttpErrorCode) {
    super(code)
    this.name = 'SourceHttpError'
  }
}
const maxResponseBytes = 8 * 1024 * 1024
const responseHeaders = new Set([
  'last-modified',
  'content-type',
  'etag',
  'link',
  'retry-after',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ogw-ratelimit-reset',
])
function fail(code: SourceHttpErrorCode): never {
  throw new SourceHttpError(code)
}
function projectHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    fail('SOURCE_HTTP_INVALID_RESPONSE')
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase()
    if (!responseHeaders.has(name)) continue
    if (
      Object.hasOwn(result, name) ||
      typeof value !== 'string' ||
      value.length > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      fail('SOURCE_HTTP_INVALID_RESPONSE')
    result[name] = value
  }
  return result
}
/** Host-only capability: adapters cannot change the TLS policy or choose another domain. */
export function createSourceHttpTransport(
  responseTransport: (
    input: HttpsResponseInput,
  ) => Promise<HttpsResponse> = requestHttpsResponse,
): SourceHttpTransport {
  return async (input) => {
    // Snapshot caller-owned scope and header values before any asynchronous operation.
    const { url, allowedDomain, bearerToken, signal } = input
    const headers =
      input.headers === undefined ? undefined : { ...input.headers }
    try {
      const target = new URL(url)
      if (
        typeof url !== 'string' ||
        url.length > 8192 ||
        !url.startsWith('https://') ||
        /[\\\s\u0000-\u001f\u007f]/u.test(url) ||
        /%(?![0-9a-f]{2})/i.test(url) ||
        /[%@]/.test(url.slice(8).split(/[/?#]/, 1)[0]!) ||
        url.includes('#') ||
        !['api.github.com', 'open.feishu.cn'].includes(allowedDomain) ||
        target.hostname !== allowedDomain ||
        target.username ||
        target.password ||
        (target.port && target.port !== '443') ||
        typeof bearerToken !== 'string' ||
        bearerToken.length > 8192 ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(bearerToken) ||
        url.includes(bearerToken) ||
        decodeURIComponent(url).includes(bearerToken) ||
        !signal ||
        typeof signal.addEventListener !== 'function'
      )
        fail('SOURCE_HTTP_INVALID_REQUEST')
      if (headers) {
        const names = new Set<string>()
        for (const [key, value] of Object.entries(headers)) {
          const name = key.toLowerCase()
          if (
            ![
              'accept',
              'x-github-api-version',
              'if-none-match',
              'if-modified-since',
            ].includes(name) ||
            names.has(name) ||
            typeof value !== 'string' ||
            !value ||
            value.length > 2048 ||
            /[\u0000-\u001f\u007f]/u.test(value)
          )
            fail('SOURCE_HTTP_INVALID_REQUEST')
          names.add(name)
        }
      }
    } catch {
      fail('SOURCE_HTTP_INVALID_REQUEST')
    }
    if (signal.aborted) fail('SOURCE_HTTP_CANCELLED')
    let response: HttpsResponse
    try {
      response = await responseTransport({
        url,
        allowedDomain,
        bearerToken,
        signal,
        headers,
        timeoutMs: 15000,
        maxResponseBytes,
      })
    } catch (error) {
      if (signal.aborted) fail('SOURCE_HTTP_CANCELLED')
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined
      if (code === 'HTTP_TIMEOUT') fail('SOURCE_HTTP_TIMEOUT')
      if (code === 'HTTP_LIMIT_EXCEEDED') fail('SOURCE_HTTP_LIMIT_EXCEEDED')
      if (code === 'HTTP_CANCELLED') fail('SOURCE_HTTP_CANCELLED')
      fail('SOURCE_HTTP_FAILED')
    }
    if (signal.aborted) fail('SOURCE_HTTP_CANCELLED')
    if (!response || !Number.isInteger(response.status))
      fail('SOURCE_HTTP_INVALID_RESPONSE')
    const status = response.status
    const safeHeaders = projectHeaders(response.headers)
    if (
      [304, 401, 403, 404, 429].includes(status) ||
      (status === 400 && allowedDomain === 'open.feishu.cn')
    ) {
      // Error text is never exposed. Retain only a canonical secondary-limit hint.
      let body: { message: string } | { code: number } | null = null
      if (
        (status === 403 ||
          (status === 400 && allowedDomain === 'open.feishu.cn')) &&
        response.bytes instanceof Uint8Array &&
        response.bytes.byteLength <= 8192 &&
        /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;[^\r\n]*)?$/i.test(
          safeHeaders['content-type'] ?? '',
        )
      ) {
        try {
          const parsed = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(response.bytes),
          )
          if (status === 400 && parsed && Number.isSafeInteger(parsed.code))
            body = { code: parsed.code }
          if (
            status === 403 &&
            parsed &&
            typeof parsed.message === 'string' &&
            parsed.message.length <= 4096 &&
            /secondary rate limit/i.test(parsed.message)
          )
            body = { message: 'secondary rate limit' }
        } catch {
          /* malformed error content does not hide the HTTP status */
        }
      }
      return { status, headers: safeHeaders, body }
    }
    if (status < 200 || status >= 300) fail('SOURCE_HTTP_FAILED')
    if (
      !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;[^\r\n]*)?$/i.test(
        safeHeaders['content-type'] ?? '',
      )
    )
      fail('SOURCE_HTTP_INVALID_RESPONSE')
    if (!(response.bytes instanceof Uint8Array))
      fail('SOURCE_HTTP_INVALID_RESPONSE')
    if (response.bytes.byteLength > maxResponseBytes)
      fail('SOURCE_HTTP_LIMIT_EXCEEDED')
    // Copy bytes, then decode and parse synchronously. No buffer owned by transport escapes.
    const bytes = Uint8Array.from(response.bytes)
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      fail('SOURCE_HTTP_INVALID_RESPONSE')
    }
    return { status, headers: safeHeaders, body }
  }
}

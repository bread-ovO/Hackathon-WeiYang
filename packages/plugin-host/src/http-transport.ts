import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isPublicAddress } from './network-address'

export interface HttpsResponseInput {
  url: string
  allowedDomain: string
  maxResponseBytes: number
  timeoutMs: number
  signal?: AbortSignal
  bearerToken?: string
  headers?: Record<string, string>
}
export interface HttpsResponse {
  status: number
  headers: Record<string, string>
  bytes: Uint8Array
}
export type HttpTransport = (
  input: Omit<HttpsResponseInput, 'headers'>,
) => Promise<Uint8Array>
export type HttpTransportErrorCode =
  | 'HTTP_INVALID_REQUEST'
  | 'HTTP_ADDRESS_DENIED'
  | 'HTTP_REQUEST_FAILED'
  | 'HTTP_TIMEOUT'
  | 'HTTP_CANCELLED'
  | 'HTTP_REDIRECT_DENIED'
  | 'HTTP_RESPONSE_INVALID'
  | 'HTTP_LIMIT_EXCEEDED'
export class HttpTransportError extends Error {
  constructor(readonly code: HttpTransportErrorCode) {
    super(code)
    this.name = 'HttpTransportError'
  }
}

/** Direct TLS only; environment proxy settings and pooled sockets are unused.
 * DNS may finish after cancellation, but cannot start a request after settlement.
 * Public IP classification cannot protect against host routing/VPN interception.
 */
export const requestHttpsJson: HttpTransport = async (input) =>
  (await requestResponse(input, true)).bytes
export const requestHttpsResponse = (
  input: HttpsResponseInput,
): Promise<HttpsResponse> => requestResponse(input, false)
function requestResponse(
  input: HttpsResponseInput,
  jsonOnly: boolean,
): Promise<HttpsResponse> {
  // Capture caller-owned options before DNS yields so validation, execution,
  // and abort cleanup all observe the same authorized values.
  const {
    url,
    allowedDomain,
    maxResponseBytes,
    timeoutMs,
    signal,
    bearerToken,
    headers,
  } = input
  const options = {
    url,
    allowedDomain,
    maxResponseBytes,
    timeoutMs,
    signal,
    bearerToken,
  }
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined
    let response: IncomingMessage | undefined
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => fail('HTTP_CANCELLED')
    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
    const fail = (code: HttpTransportErrorCode) => {
      if (settled) return
      settled = true
      cleanup()
      req?.destroy()
      response?.destroy()
      reject(new HttpTransportError(code))
    }
    let url: URL
    const outgoing: Record<string, string> = {}
    try {
      const allowed: Record<string, string> = {
        accept: 'Accept',
        'if-none-match': 'If-None-Match',
        'if-modified-since': 'If-Modified-Since',
        'x-github-api-version': 'X-GitHub-Api-Version',
      }
      if (headers !== undefined) {
        if (!headers || typeof headers !== 'object' || Array.isArray(headers))
          throw new Error()
        let headerBytes = 0
        for (const [key, value] of Object.entries(headers)) {
          const canonical = Object.hasOwn(allowed, key.toLowerCase())
            ? allowed[key.toLowerCase()]
            : undefined
          if (
            !canonical ||
            Object.hasOwn(outgoing, canonical) ||
            typeof value !== 'string' ||
            !value.trim() ||
            value.length > 2048 ||
            /[^\x20-\x7e]/.test(value)
          )
            throw new Error()
          headerBytes += Buffer.byteLength(key + value)
          if (headerBytes > 4096) throw new Error()
          outgoing[canonical] = value
        }
      }
      if (typeof options.url !== 'string' || options.url.length > 8192) {
        fail('HTTP_INVALID_REQUEST')
        return
      }
      url = new URL(options.url)
      if (
        !options.url.startsWith('https://') ||
        /[\\\s\x00-\x1f\x7f]/.test(options.url) ||
        /%(?![0-9a-f]{2})/i.test(options.url) ||
        /[%@]/.test(options.url.slice(8).split(/[/?#]/, 1)[0]!) ||
        url.protocol !== 'https:' ||
        (url.port && url.port !== '443') ||
        url.username ||
        url.password ||
        options.url.includes('#') ||
        url.hostname !== options.allowedDomain ||
        isIP(url.hostname) ||
        !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          options.allowedDomain,
        ) ||
        !Number.isSafeInteger(options.maxResponseBytes) ||
        options.maxResponseBytes < 1 ||
        options.maxResponseBytes > 16 * 1024 * 1024 ||
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 120_000 ||
        (options.bearerToken !== undefined &&
          (options.bearerToken.length > 8192 ||
            !/^[A-Za-z0-9._~+/-]+=*$/.test(options.bearerToken)))
      ) {
        fail('HTTP_INVALID_REQUEST')
        return
      }
    } catch {
      fail('HTTP_INVALID_REQUEST')
      return
    }
    if (options.signal?.aborted) {
      fail('HTTP_CANCELLED')
      return
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => fail('HTTP_TIMEOUT'), options.timeoutMs)
    void lookup(url.hostname, { all: true, verbatim: true })
      .then((addresses) => {
        if (settled) return
        if (
          !addresses.length ||
          addresses.some(
            ({ address, family }) =>
              isIP(address) !== family || !isPublicAddress(address),
          )
        ) {
          fail('HTTP_ADDRESS_DENIED')
          return
        }
        const selected = addresses[0]!
        req = request(
          {
            protocol: 'https:',
            hostname: url.hostname,
            port: 443,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            agent: false,
            rejectUnauthorized: true,
            servername: url.hostname,
            family: selected.family,
            maxHeaderSize: 16 * 1024,
            lookup: (_hostname, options, callback) => {
              // Never perform another DNS lookup. Preserve Node's all:true callback shape.
              if (typeof options === 'object' && options.all)
                callback(null, [selected] as unknown as string, selected.family)
              else callback(null, selected.address, selected.family)
            },
            headers: {
              'User-Agent': 'BUGU/0.1 (declarative-source)',
              Accept: 'application/json',
              'Accept-Encoding': 'identity',
              ...outgoing,
              ...(options.bearerToken === undefined
                ? {}
                : { Authorization: `Bearer ${options.bearerToken}` }),
            },
          },
          (res) => {
            response = res
            res.on('error', () => fail('HTTP_REQUEST_FAILED'))
            res.on('aborted', () => fail('HTTP_REQUEST_FAILED'))
            if (settled) {
              res.destroy()
              return
            }
            const status = res.statusCode ?? 0
            if (status >= 300 && status < 400 && (jsonOnly || status !== 304)) {
              fail('HTTP_REDIRECT_DENIED')
              return
            }
            const noBody = status === 304 && !jsonOnly
            const isErrorResponse =
              !jsonOnly && [400, 401, 403, 404, 429].includes(status)
            const type = res.headers['content-type']
            if (
              (!noBody &&
                !isErrorResponse &&
                (status < 200 || status >= 300)) ||
              (!noBody &&
                !isErrorResponse &&
                (typeof type !== 'string' ||
                  !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;[^\r\n]*)?$/i.test(
                    type,
                  ))) ||
              (!noBody &&
                res.headers['content-encoding'] !== undefined &&
                res.headers['content-encoding'] !== 'identity')
            ) {
              fail('HTTP_RESPONSE_INVALID')
              return
            }
            const projected: Record<string, string> = {}
            const responseKeys = [
              'etag',
              'link',
              'retry-after',
              'x-ratelimit-reset',
              'x-ogw-ratelimit-reset',
              'x-ratelimit-remaining',
              'last-modified',
              'content-type',
            ]
            for (const [name, value] of Object.entries(res.headers)) {
              const key = name.toLowerCase()
              if (!responseKeys.includes(key)) continue
              if (
                typeof value !== 'string' ||
                value.length > 8192 ||
                /[\x00-\x1f\x7f]/.test(value) ||
                Object.hasOwn(projected, key)
              ) {
                fail('HTTP_RESPONSE_INVALID')
                return
              }
              projected[key] = value
            }
            const length = res.headers['content-length']
            if (
              !noBody &&
              length !== undefined &&
              (!/^\d+$/.test(length) ||
                Number(length) > options.maxResponseBytes)
            ) {
              fail('HTTP_LIMIT_EXCEEDED')
              return
            }
            const chunks: Buffer[] = []
            let bytes = 0
            res.on('data', (chunk: Buffer) => {
              if (settled) return
              bytes += chunk.length
              if (noBody && bytes > 0) {
                fail('HTTP_RESPONSE_INVALID')
                return
              }
              if (bytes > options.maxResponseBytes) {
                fail('HTTP_LIMIT_EXCEEDED')
                return
              }
              chunks.push(chunk)
            })
            res.on('end', () => {
              if (settled) return
              if (!res.complete) {
                fail('HTTP_REQUEST_FAILED')
                return
              }
              settled = true
              cleanup()
              resolve({
                status,
                headers: projected,
                bytes: Buffer.concat(chunks, bytes),
              })
            })
            res.on('close', () => {
              if (!res.complete) fail('HTTP_REQUEST_FAILED')
            })
          },
        )
        req.on('error', () => fail('HTTP_REQUEST_FAILED'))
        req.end()
      })
      .catch(() => fail('HTTP_REQUEST_FAILED'))
  })
}

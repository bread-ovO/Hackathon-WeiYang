import { createHash } from 'node:crypto'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
import { parseSourceManifest } from './manifest'
import {
  requestHttpsJson,
  HttpTransportError,
  type HttpTransport,
} from './http-transport'

export type HttpJsonErrorCode =
  | 'INVALID_MANIFEST'
  | 'UNAUTHORIZED_SOURCE'
  | 'INVALID_CURSOR'
  | 'PAGINATION_LOOP'
  | 'CURSOR_LIMIT_EXCEEDED'
  | 'RATE_LIMITED'
  | 'READER_BUSY'
  | 'CANCELLED'
  | 'TRANSPORT_FAILED'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'INVALID_RECORDS'
  | 'INVALID_SOURCE_EVENT'
  | 'PAGE_LIMIT_EXCEEDED'
  | 'INVALID_CLOCK'
export class HttpJsonError extends Error {
  constructor(readonly code: HttpJsonErrorCode) {
    super(code)
    this.name = 'HttpJsonError'
  }
}
export interface HttpJsonCursor {
  version: 1
  bindingSha256: string
  next: string | null
  done: boolean
  seen: string[]
}
export interface HttpJsonBatch {
  events: SourceEvent[]
  cursor: HttpJsonCursor
  done: boolean
  pagesRead: number
}
export interface HttpJsonReaderInput {
  manifest: unknown
  authorization: {
    sourceInstanceId: string
    domain: string
    credential?: { id: string; token: string }
  }
  transport?: HttpTransport
  now?: () => number
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  return JSON.stringify(value)
}
function pointer(value: unknown, path: string): unknown {
  let current = value
  for (const segment of path.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    )
      throw new HttpJsonError('INVALID_RECORDS')
    current = (current as Record<string, unknown>)[key]
  }
  return current
}
function token(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}
const cursorKeys = ['version', 'bindingSha256', 'next', 'done', 'seen']
function readCursor(value: unknown, binding: string): HttpJsonCursor {
  if (value === undefined)
    return {
      version: 1,
      bindingSha256: binding,
      next: null,
      done: false,
      seen: [],
    }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpJsonError('INVALID_CURSOR')
  const c = value as HttpJsonCursor
  if (
    Object.keys(c).length !== cursorKeys.length ||
    Object.keys(c).some((k) => !cursorKeys.includes(k)) ||
    c.version !== 1 ||
    c.bindingSha256 !== binding ||
    typeof c.done !== 'boolean' ||
    (c.next !== null && (!token(c.next) || !c.next.length)) ||
    !Array.isArray(c.seen) ||
    c.seen.length > 128 ||
    c.seen.some((t) => typeof t !== 'string' || !/^[0-9a-f]{64}$/.test(t)) ||
    new Set(c.seen).size !== c.seen.length ||
    (c.done && c.next !== null) ||
    (!c.done && c.seen.length > 0 && c.next === null)
  )
    throw new HttpJsonError('INVALID_CURSOR')
  return { ...c, seen: [...c.seen] }
}
export function createHttpJsonReader(input: HttpJsonReaderInput) {
  let manifest: ReturnType<typeof parseSourceManifest>
  try {
    manifest = parseSourceManifest(input.manifest)
  } catch {
    throw new HttpJsonError('INVALID_MANIFEST')
  }
  if (manifest.kind !== 'http-json') throw new HttpJsonError('INVALID_MANIFEST')
  if (!input.authorization || typeof input.authorization !== 'object')
    throw new HttpJsonError('UNAUTHORIZED_SOURCE')
  const { sourceInstanceId, domain, credential } = input.authorization
  if (
    typeof sourceInstanceId !== 'string' ||
    !sourceInstanceId.trim() ||
    sourceInstanceId.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(sourceInstanceId) ||
    domain !== manifest.permissions.domains[0] ||
    credential?.id !== manifest.transport.credentialId ||
    (manifest.transport.credentialId === undefined && credential !== undefined)
  )
    throw new HttpJsonError('UNAUTHORIZED_SOURCE')
  if (
    credential &&
    (typeof credential.token !== 'string' ||
      !credential.token.length ||
      credential.token.length > 8192 ||
      /[\u0000-\u001f\u007f]/.test(credential.token))
  )
    throw new HttpJsonError('UNAUTHORIZED_SOURCE')
  const bearerToken = credential?.token
  const binding = sha(
    canonical({
      manifest,
      sourceInstanceId,
      domain,
      credentialId: credential?.id ?? null,
    }),
  )
  const transport = input.transport ?? requestHttpsJson
  const now = input.now ?? Date.now
  let timestamps: number[] = []
  let lastTime = 0
  let busy = false
  return {
    async read(
      options: { cursor?: HttpJsonCursor; signal?: AbortSignal } = {},
    ): Promise<HttpJsonBatch> {
      const signal = options.signal
      if (busy) throw new HttpJsonError('READER_BUSY')
      let cursor = readCursor(options.cursor, binding)
      const cancelled = () => {
        if (signal?.aborted) throw new HttpJsonError('CANCELLED')
      }
      cancelled()
      if (cursor.done) return { events: [], cursor, done: true, pagesRead: 0 }
      busy = true
      try {
        const events: SourceEvent[] = []
        let characters = 0
        let pagesRead = 0
        const result = (): HttpJsonBatch => ({
          events,
          cursor,
          done: cursor.done,
          pagesRead,
        })
        for (let page = 0; page < manifest.transport.maxPages; page++) {
          cancelled()
          const time = now()
          if (!Number.isFinite(time) || time < 0)
            throw new HttpJsonError('INVALID_CLOCK')
          lastTime = Math.max(lastTime, time)
          timestamps = timestamps.filter((t) => lastTime - t < 60000)
          if (timestamps.length >= manifest.transport.requestsPerMinute) {
            if (pagesRead) return result()
            throw new HttpJsonError('RATE_LIMITED')
          }
          if (cursor.seen.length >= 128)
            throw new HttpJsonError('CURSOR_LIMIT_EXCEEDED')
          const requestHash = sha(JSON.stringify(cursor.next))
          if (cursor.seen.includes(requestHash))
            throw new HttpJsonError('PAGINATION_LOOP')
          const url = new URL(manifest.transport.url)
          if (cursor.next !== null) {
            if (!manifest.transport.pagination)
              throw new HttpJsonError('INVALID_CURSOR')
            url.searchParams.set(
              manifest.transport.pagination.cursorParameter,
              cursor.next,
            )
          }
          timestamps.push(lastTime)
          let bytes: Uint8Array
          try {
            bytes = await transport({
              url: url.href,
              allowedDomain: domain,
              maxResponseBytes: manifest.transport.maxResponseBytes,
              timeoutMs: 15000,
              ...(signal ? { signal } : {}),
              ...(bearerToken ? { bearerToken } : {}),
            })
          } catch (error) {
            cancelled()
            if (error instanceof HttpTransportError) throw error
            throw new HttpJsonError('TRANSPORT_FAILED')
          }
          cancelled()
          if (!(bytes instanceof Uint8Array))
            throw new HttpJsonError('INVALID_JSON')
          if (bytes.byteLength > manifest.transport.maxResponseBytes)
            throw new HttpJsonError('RESPONSE_TOO_LARGE')
          let decoded: string
          try {
            decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          } catch {
            throw new HttpJsonError('INVALID_UTF8')
          }
          let body: unknown
          try {
            body = JSON.parse(decoded)
          } catch {
            throw new HttpJsonError('INVALID_JSON')
          }
          const records = pointer(body, manifest.transport.recordsPointer)
          if (!Array.isArray(records))
            throw new HttpJsonError('INVALID_RECORDS')
          const mapped = records.map((record) => {
            if (!record || typeof record !== 'object' || Array.isArray(record))
              throw new HttpJsonError('INVALID_RECORDS')
            try {
              return parseSourceEvent({
                schemaVersion: 1,
                sourceInstanceId,
                externalId: pointer(
                  record,
                  manifest.mapping.externalId.pointer,
                ),
                revision: pointer(record, manifest.mapping.revision.pointer),
                occurredAt: pointer(
                  record,
                  manifest.mapping.occurredAt.pointer,
                ),
                role:
                  'constant' in manifest.mapping.role
                    ? manifest.mapping.role.constant
                    : pointer(record, manifest.mapping.role.pointer),
                text: pointer(record, manifest.mapping.text.pointer),
                ...(manifest.mapping.operation
                  ? {
                      operation: pointer(
                        record,
                        manifest.mapping.operation.pointer,
                      ),
                    }
                  : {}),
              })
            } catch {
              throw new HttpJsonError('INVALID_SOURCE_EVENT')
            }
          })
          let next: string | null = null
          if (manifest.transport.pagination) {
            const value = pointer(
              body,
              manifest.transport.pagination.cursorPointer,
            )
            if (value !== null && !token(value))
              throw new HttpJsonError('INVALID_CURSOR')
            next = value === null || value === '' ? null : value
          }
          const seen = [...cursor.seen, requestHash]
          if (next !== null && seen.includes(sha(JSON.stringify(next))))
            throw new HttpJsonError('PAGINATION_LOOP')
          const pageCharacters = mapped.reduce(
            (sum, event) => sum + event.text.length,
            0,
          )
          if (
            events.length + mapped.length >
              Math.min(manifest.sampling.maxRecordsPerRun, 500) ||
            characters + pageCharacters > 4 * 1024 * 1024
          ) {
            if (!pagesRead) throw new HttpJsonError('PAGE_LIMIT_EXCEEDED')
            return result()
          }
          events.push(...mapped)
          characters += pageCharacters
          pagesRead++
          cursor = {
            version: 1,
            bindingSha256: binding,
            next,
            done: next === null,
            seen,
          }
          if (cursor.done) return result()
        }
        return result()
      } finally {
        busy = false
      }
    },
  }
}

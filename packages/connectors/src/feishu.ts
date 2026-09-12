import { validateSourceEvent, type SourceEvent } from '@memo/contracts'
import type { SourceHttpTransport } from './http-client'

export interface SourceAdapter {
  readonly kind: string
  pull(
    cursor: string,
    signal: AbortSignal,
  ): Promise<{ events: SourceEvent[]; nextCursor: string }>
}
export interface FeishuMessagePage {
  items: readonly FeishuMessage[]
  pageToken?: string
  hasMore?: boolean
}
export interface FeishuMessage {
  messageId: string
  createTime: string
  senderId?: string
  senderType?: 'user' | 'app' | 'bot' | 'anonymous' | 'unknown'
  content: string
  deleted?: boolean
  revision?: string
}
export type FeishuPageFetcher = (
  cursor: string,
  signal: AbortSignal,
) => Promise<FeishuMessagePage>
export interface FeishuApiMessage {
  message_id?: string
  create_time?: string
  sender?: { sender_type?: string; id?: string }
  body?: { content?: string }
  deleted?: boolean
  update_time?: string
}
export interface FeishuApiPage {
  code?: number
  data?: { items?: FeishuApiMessage[]; page_token?: string; has_more?: boolean }
}
function invalid(): never {
  throw new Error('INVALID_FEISHU_RESPONSE')
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    invalid()
  return value as Record<string, unknown>
}
function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined
}
function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (!empty && !value.length)
  )
    invalid()
  return value
}
function identifier(value: unknown, max: number): string {
  const result = text(value, max)
  if (/[\s\u0000-\u001f\u007f]/u.test(result)) invalid()
  return result
}
function timestamp(value: unknown, millisecondsOnly = false): string {
  const raw = text(value, 32)
  if (/^(0|[1-9]\d{0,14})$/.test(raw)) {
    const ms = Number(raw)
    if (!Number.isSafeInteger(ms) || ms > 253402300799999) invalid()
    return new Date(ms).toISOString()
  }
  // Normalized adapters may supply ISO UTC, but the official API returns milliseconds.
  if (
    millisecondsOnly ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw)
  )
    invalid()
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) invalid()
  const normalized = new Date(ms).toISOString()
  if (normalized.slice(0, 19) !== raw.slice(0, 19)) invalid()
  return normalized
}
function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error('FEISHU_ABORTED')
}
function pageCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error('INVALID_PAGE_CURSOR')
  return value
}
function nextCursor(
  page: Record<string, unknown>,
  cursor: string,
  tokenKey: string,
  moreKey: string,
): string {
  const more = own(page, moreKey),
    token = own(page, tokenKey)
  if (typeof more !== 'boolean') invalid()
  if (token !== undefined) pageCursor(token)
  if (!more) return ''
  if (typeof token !== 'string' || !token || token === cursor)
    throw new Error('INVALID_PAGE_CURSOR')
  return token
}
export function decodeFeishuContent(content: string | undefined): string {
  if (content === undefined || content === '') return ''
  text(content, 65536, true)
  try {
    const value: unknown = JSON.parse(content)
    if (typeof value === 'string') return value
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, 'text') &&
      typeof (value as { text: unknown }).text === 'string'
    )
      return (value as { text: string }).text
  } catch {
    /* Non-JSON content remains untrusted plain text. */
  }
  return content
}
export interface FeishuHistoryWindow {
  startTime?: Date
  endTime?: Date
}
/** Official response: https://www.feishu.cn/content/mtb6n3ah (history messages). */
export function createFeishuMessagesFetcher(
  token: string,
  chatId: string,
  transport: SourceHttpTransport,
  window: FeishuHistoryWindow = {},
): FeishuPageFetcher {
  if (
    typeof token !== 'string' ||
    !token ||
    token.length > 8192 ||
    /[\s\u0000-\u001f\u007f]/u.test(token) ||
    typeof transport !== 'function'
  )
    throw new Error('INVALID_FEISHU_CLIENT_CONFIG')
  identifier(chatId, 256)
  const start = window.startTime?.getTime(),
    end = window.endTime?.getTime()
  if (
    (start !== undefined && (!Number.isFinite(start) || start < 0)) ||
    (end !== undefined && (!Number.isFinite(end) || end < 0)) ||
    (start !== undefined && end !== undefined && start > end)
  )
    throw new Error('INVALID_FEISHU_HISTORY_WINDOW')
  return async (cursor, signal) => {
    pageCursor(cursor)
    checkCancelled(signal)
    const params = new URLSearchParams({
      container_id_type: 'chat',
      container_id: chatId,
      page_size: '50',
    })
    if (cursor) params.set('page_token', cursor)
    if (start !== undefined)
      params.set('start_time', String(Math.floor(start / 1000)))
    if (end !== undefined)
      params.set('end_time', String(Math.floor(end / 1000)))
    let response
    try {
      response = await transport({
        url: `https://open.feishu.cn/open-apis/im/v1/messages?${params}`,
        allowedDomain: 'open.feishu.cn',
        bearerToken: token,
        signal,
      })
    } catch {
      checkCancelled(signal)
      throw new Error('FEISHU_HTTP_FAILED')
    }
    checkCancelled(signal)
    if (!response || response.status !== 200)
      throw new Error('FEISHU_HTTP_FAILED')
    const body = object(response.body)
    if (own(body, 'code') !== 0) invalid()
    const data = object(own(body, 'data')),
      items = own(data, 'items')
    if (!Array.isArray(items) || items.length > 50) invalid()
    const next = nextCursor(data, cursor, 'page_token', 'has_more')
    return {
      items: items.map((raw): FeishuMessage => {
        const item = object(raw),
          sender = object(own(item, 'sender'))
        const type = own(sender, 'sender_type')
        if (
          type !== 'user' &&
          type !== 'app' &&
          type !== 'anonymous' &&
          type !== 'unknown'
        )
          invalid()
        const deleted = own(item, 'deleted')
        if (deleted !== undefined && typeof deleted !== 'boolean') invalid()
        const content =
          own(item, 'body') === undefined && deleted === true
            ? ''
            : own(object(own(item, 'body')), 'content')
        const update = own(item, 'update_time')
        if (update !== undefined) timestamp(update, true)
        return {
          messageId: identifier(own(item, 'message_id'), 256),
          createTime: timestamp(own(item, 'create_time'), true),
          senderType: type,
          content: decodeFeishuContent(text(content, 65536, true)),
          ...(deleted !== undefined ? { deleted } : {}),
          ...(update !== undefined ? { revision: text(update, 32) } : {}),
        }
      }),
      pageToken: next,
      hasMore: data.has_more as boolean,
    }
  }
}
/** Keep legacy upsert revisions unchanged. A visible deletion is a distinct
 * immutable fact even when the provider does not advance update_time. */
async function retractRevision(base: string): Promise<string> {
  if (base.length <= 120) return `${base}:retract`
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(base)),
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}:retract`
}
/** Only the provider's explicit deleted flag creates a retraction event. */
export class FeishuHistoryAdapter implements SourceAdapter {
  readonly kind = 'feishu.im'
  private readonly transitions = new Map<string, string>()
  constructor(
    private readonly sourceInstanceId: string,
    private readonly fetchPage: FeishuPageFetcher,
  ) {
    identifier(sourceInstanceId, 128)
  }
  async pull(
    cursor: string,
    signal: AbortSignal,
  ): Promise<{ events: SourceEvent[]; nextCursor: string }> {
    pageCursor(cursor)
    checkCancelled(signal)
    let raw: FeishuMessagePage
    try {
      raw = await this.fetchPage(cursor, signal)
    } catch {
      checkCancelled(signal)
      throw new Error('FEISHU_FETCH_FAILED')
    }
    checkCancelled(signal)
    const page = object(raw),
      items = own(page, 'items')
    if (!Array.isArray(items) || items.length > 50) invalid()
    const next = nextCursor(page, cursor, 'pageToken', 'hasMore')
    // Track transitions, rather than consumed cursors, so a failed sink may safely retry a page.
    let step = next
    const visited = new Set<string>([cursor])
    while (step) {
      if (visited.has(step)) throw new Error('INVALID_PAGE_CURSOR')
      visited.add(step)
      step = this.transitions.get(step) ?? ''
    }
    if (!this.transitions.has(cursor) && this.transitions.size >= 10000)
      throw new Error('INVALID_PAGE_CURSOR')
    const events = await Promise.all(
      items.map(async (raw): Promise<SourceEvent> => {
        const message = object(raw),
          type = own(message, 'senderType'),
          deleted = own(message, 'deleted')
        if (
          !['user', 'app', 'bot', 'anonymous', 'unknown'].includes(
            type as string,
          )
        )
          invalid()
        if (deleted !== undefined && typeof deleted !== 'boolean') invalid()
        const occurredAt = timestamp(own(message, 'createTime'))
        const revision = own(message, 'revision')
        const content = text(own(message, 'content'), 65536, true)
        const event: SourceEvent = {
          schemaVersion: 1,
          sourceInstanceId: this.sourceInstanceId,
          externalId: identifier(own(message, 'messageId'), 256),
          revision: deleted
            ? await retractRevision(
                revision === undefined ? 'deleted' : identifier(revision, 128),
              )
            : revision === undefined
              ? occurredAt
              : identifier(revision, 128),
          occurredAt,
          role:
            type === 'user'
              ? 'user'
              : type === 'app' || type === 'bot'
                ? 'assistant'
                : 'tool',
          text: deleted ? '' : content,
          ...(deleted ? { operation: 'retract' as const } : {}),
        }
        if (!validateSourceEvent(event)) invalid()
        return event
      }),
    )
    checkCancelled(signal)
    this.transitions.set(cursor, next)
    if (!next) this.transitions.clear()
    return { events, nextCursor: next }
  }
}

import type { SourceEvent } from '@memo/contracts'

export interface SourceAdapter {
  readonly kind:string
  // The host grants scope before creating an adapter. No implementation is enabled yet.
  pull(cursor:string, signal:AbortSignal): Promise<{events:SourceEvent[]; nextCursor:string}>
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
  senderType?: 'user' | 'app' | 'bot'
  content: string
  deleted?: boolean
  revision?: string
}

export type FeishuPageFetcher = (cursor: string, signal: AbortSignal) => Promise<FeishuMessagePage>

export interface FeishuApiMessage {
  message_id?: string
  create_time?: string
  sender?: { sender_type?: string }
  body?: { content?: string }
  deleted?: boolean
  update_time?: string
}

export interface FeishuApiPage {
  data?: { items?: FeishuApiMessage[]; page_token?: string; has_more?: boolean }
}

export function decodeFeishuContent(content: string | undefined): string {
  if (!content) return ''
  try {
    const value: unknown = JSON.parse(content)
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text
  } catch { /* plain text responses are accepted */ }
  return content
}

export interface FeishuHistoryWindow { startTime?: Date; endTime?: Date }

export function createFeishuMessagesFetcher(token: string, chatId: string, baseUrl = 'https://open.feishu.cn', window: FeishuHistoryWindow = {}): FeishuPageFetcher {
  if (!token || !chatId) throw new Error('INVALID_FEISHU_CLIENT_CONFIG')
  const start = window.startTime?.getTime()
  const end = window.endTime?.getTime()
  if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end)) || (start !== undefined && end !== undefined && start > end)) throw new Error('INVALID_FEISHU_HISTORY_WINDOW')
  return async (cursor, signal) => {
    const params = new URLSearchParams({ container_id_type: 'chat', container_id: chatId, page_size: '50' })
    if (cursor) params.set('page_token', cursor)
    if (start !== undefined) params.set('start_time', String(Math.floor(start / 1000)))
    if (end !== undefined) params.set('end_time', String(Math.floor(end / 1000)))
    const response = await fetch(`${baseUrl}/open-apis/im/v1/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` }, signal,
    })
    if (!response.ok) throw new Error(`FEISHU_HTTP_${response.status}`)
    const body = (await response.json()) as FeishuApiPage
    const data = body.data
    if (!data?.items) throw new Error('INVALID_FEISHU_RESPONSE')
    return {
      items: data.items.map((item) => ({
        messageId: item.message_id ?? '', createTime: item.create_time ?? '',
        senderType: item.sender?.sender_type === 'bot' ? 'bot' : 'user',
        content: decodeFeishuContent(item.body?.content), deleted: item.deleted, revision: item.update_time,
      })),
      pageToken: data.page_token, hasMore: data.has_more,
    }
  }
}

/** Converts the official IM list response into the versioned event envelope. */
export class FeishuHistoryAdapter implements SourceAdapter {
  readonly kind = 'feishu.im'
  constructor(
    private readonly sourceInstanceId: string,
    private readonly fetchPage: FeishuPageFetcher,
  ) {}

  async pull(cursor: string, signal: AbortSignal): Promise<{ events: SourceEvent[]; nextCursor: string }> {
    const page = await this.fetchPage(cursor, signal)
    const events = page.items.map((message): SourceEvent => ({
      schemaVersion: 1,
      sourceInstanceId: this.sourceInstanceId,
      externalId: message.messageId,
      revision: message.revision ?? (message.deleted ? 'deleted' : message.createTime),
      occurredAt: new Date(message.createTime).toISOString(),
      role: message.senderType === 'app' || message.senderType === 'bot' ? 'assistant' : 'user',
      text: message.deleted ? '' : message.content,
    }))
    return { events, nextCursor: page.hasMore === false ? '' : page.pageToken ?? '' }
  }
}

export interface GithubPullRequest { number: number; title: string; html_url: string; state: 'open' | 'closed'; merged_at?: string | null; updated_at: string; user?: { login?: string } }
export type GithubPageFetcher = (cursor: string, signal: AbortSignal) => Promise<{ events: SourceEvent[]; nextCursor: string }>

export interface PollResult { nextCursor: string; inserted: number }
export class SourcePoller {
  constructor(private readonly pullPage: FeishuPageFetcher, private readonly onPage: (page: FeishuMessagePage, nextCursor: string) => Promise<number>, private readonly baseDelayMs = 1000, private readonly maxDelayMs = 60000, private readonly maxFailures = 3) {
    if (!Number.isSafeInteger(maxFailures) || maxFailures < 1) throw new Error('INVALID_POLL_FAILURE_LIMIT')
  }
  async run(cursor: string, signal: AbortSignal): Promise<string> {
    let current = cursor
    let delay = this.baseDelayMs
    let failures = 0
    while (!signal.aborted) {
      try {
        const page = await this.pullPage(current, signal)
        if (page.hasMore && !page.pageToken) throw new Error('INVALID_PAGE_CURSOR')
        await this.onPage(page, page.hasMore === false ? '' : page.pageToken ?? '')
        current = page.hasMore === false ? '' : page.pageToken ?? ''
        delay = this.baseDelayMs
        failures = 0
        if (!current) return current
        await this.wait(delay, signal)
      } catch (error) {
        if (signal.aborted) break
        failures += 1
        if (failures >= this.maxFailures) throw error
        await this.wait(delay, signal)
        delay = Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, delay * 2))
        if (error instanceof Error && error.name === 'AbortError') break
      }
    }
    return current
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => { if (signal.aborted) return resolve(); const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
  }
}

export function createGithubPullRequestsFetcher(token: string, owner: string, repo: string, baseUrl = 'https://api.github.com'): GithubPageFetcher {
  if (!token || !owner || !repo) throw new Error('INVALID_GITHUB_CLIENT_CONFIG')
  return async (cursor, signal) => {
    if (cursor && (!/^\d+$/.test(cursor) || Number(cursor) < 1)) throw new Error('INVALID_GITHUB_CURSOR')
    const params = new URLSearchParams({ per_page: '100', sort: 'updated', direction: 'desc' })
    if (cursor) params.set('page', cursor)
    const response = await fetch(`${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, signal })
    if (!response.ok) throw new Error(`GITHUB_HTTP_${response.status}`)
    const pulls = (await response.json()) as GithubPullRequest[]
    if (!Array.isArray(pulls)) throw new Error('INVALID_GITHUB_RESPONSE')
    const events = pulls.map((pr): SourceEvent => ({ schemaVersion: 1, sourceInstanceId: `github:${owner}/${repo}`, externalId: `pr:${pr.number}`, revision: pr.updated_at, occurredAt: new Date(pr.updated_at).toISOString(), role: 'tool', text: `PR #${pr.number} ${pr.state === 'open' ? 'open' : pr.merged_at ? 'merged' : 'closed'}: ${pr.title} ${pr.html_url}` }))
    return { events, nextCursor: pulls.length === 100 ? String(Number(cursor || '1') + 1) : '' }
  }
}

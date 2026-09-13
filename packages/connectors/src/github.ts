import { createHash } from 'node:crypto'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
import type { SourceHttpTransport } from './http-client'

export interface GithubPullRequest {
  number: number
  title: string
  html_url: string
  url: string
  created_at?: string
  closed_at?: string | null
  state: 'open' | 'closed'
  merged_at: string | null
  updated_at: string
  draft: boolean
  base: { ref: string; sha: string; repo: { id: number; full_name: string } }
  head: {
    ref: string
    sha: string
    label: string
    repo: { full_name: string } | null
  }
}
export type GithubPageFetcher = (
  cursor: string,
  signal: AbortSignal,
) => Promise<{ events: SourceEvent[]; nextCursor: string }>
export type GithubErrorCode =
  | 'INVALID_GITHUB_CLIENT_CONFIG'
  | 'INVALID_GITHUB_CURSOR'
  | 'INVALID_GITHUB_RESPONSE'
  | 'GITHUB_REQUEST_FAILED'
  | 'GITHUB_CANCELLED'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_BUSY'
  | 'GITHUB_AUTH_FAILED'
  | 'GITHUB_REPOSITORY_CHANGED'
export class GithubConnectorError extends Error {
  constructor(
    readonly code: GithubErrorCode,
    readonly scope?: string,
  ) {
    super(code)
    this.name = 'GithubConnectorError'
  }
}
export class GithubRateLimitError extends GithubConnectorError {
  constructor(readonly retryAfterMs: number) {
    super('GITHUB_RATE_LIMITED')
    this.name = 'GithubRateLimitError'
  }
}
function fail(code: GithubErrorCode): never {
  throw new GithubConnectorError(code)
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f]/.test(value)
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().replace('.000Z', 'Z') === value
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const repository = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/i.test(value)
const header = (headers: Record<string, string>, name: string) =>
  Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]

/** Fixed, scrubbed classification. Permission failures must not masquerade as rate limits. */
export function checkGithubResponseStatus(response: {
  status: number
  headers: Record<string, string>
  body?: unknown
}) {
  const retry = header(response.headers, 'retry-after'),
    reset = header(response.headers, 'x-ratelimit-reset')
  const secondary =
    object(response.body) &&
    typeof response.body.message === 'string' &&
    response.body.message.length <= 4096 &&
    /secondary rate limit/i.test(response.body.message)
  const limited =
    response.status === 429 ||
    (response.status === 403 &&
      (secondary ||
        retry !== undefined ||
        header(response.headers, 'x-ratelimit-remaining') === '0'))
  if (limited) {
    let delay = 60000
    if (retry && /^\d{1,8}$/.test(retry))
      delay = Math.max(1000, Number(retry) * 1000)
    else if (retry && Number.isFinite(Date.parse(retry)))
      delay = Math.max(1000, Date.parse(retry) - Date.now())
    else if (
      header(response.headers, 'x-ratelimit-remaining') === '0' &&
      reset &&
      /^\d{1,13}$/.test(reset)
    )
      delay = Math.max(1000, Number(reset) * 1000 - Date.now())
    throw new GithubRateLimitError(delay)
  }
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  )
    fail('GITHUB_AUTH_FAILED')
}
/** Verify the selected repository even when its PR list is empty. Redirects stay forbidden by transport. */
export async function verifyGithubRepository(
  token: string,
  owner: string,
  repo: string,
  transport: SourceHttpTransport,
  signal: AbortSignal,
): Promise<number> {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token) ||
    Buffer.byteLength(token) > 8192 ||
    !repository(`${owner}/${repo}`) ||
    repo === '.' ||
    repo === '..' ||
    typeof transport !== 'function'
  )
    fail('INVALID_GITHUB_CLIENT_CONFIG')
  if (signal.aborted) fail('GITHUB_CANCELLED')
  try {
    const response = await transport({
      url: `https://api.github.com/repos/${owner}/${repo}`,
      allowedDomain: 'api.github.com',
      bearerToken: token,
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    })
    if (signal.aborted) fail('GITHUB_CANCELLED')
    checkGithubResponseStatus(response)
    if (response.status !== 200) fail('GITHUB_REQUEST_FAILED')
    const body = response.body
    if (
      !object(body) ||
      !Number.isSafeInteger(body.id) ||
      Number(body.id) < 1 ||
      !repository(body.full_name) ||
      body.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()
    )
      fail('INVALID_GITHUB_RESPONSE')
    return Number(body.id)
  } catch (error) {
    if (signal.aborted) fail('GITHUB_CANCELLED')
    if (error instanceof GithubRateLimitError)
      throw new GithubRateLimitError(error.retryAfterMs)
    if (error instanceof GithubConnectorError)
      throw new GithubConnectorError(error.code)
    fail('GITHUB_REQUEST_FAILED')
  }
}

/** Fixed selected repository, stable chronological pagination, and bounded per-URL
 * conditional cache. Does not follow redirects or assume a full page implies next.
 * SourceEvent has no metadata bag: text is a structured JSON PR observation, not a
 * decision that any user task is complete. Token remains in this fetcher's closure.
 */
export function createGithubPullRequestsFetcher(
  token: string,
  owner: string,
  repo: string,
  transport: SourceHttpTransport,
  expectedRepositoryId?: number,
): GithubPageFetcher {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(token) ||
    Buffer.byteLength(token) > 8192 ||
    !repository(`${owner}/${repo}`) ||
    repo === '.' ||
    repo === '..' ||
    typeof transport !== 'function'
  )
    fail('INVALID_GITHUB_CLIENT_CONFIG')
  if (
    expectedRepositoryId !== undefined &&
    (!Number.isSafeInteger(expectedRepositoryId) || expectedRepositoryId < 1)
  )
    fail('INVALID_GITHUB_CLIENT_CONFIG')
  const selected = `${owner}/${repo}`.toLowerCase()
  const source = `github:${selected}`
  const sourceInstanceId =
    source.length <= 128 ? source : `github:${hash(selected)}`
  const endpoint = `/repos/${owner}/${repo}/pulls`
  type Page = { events: SourceEvent[]; nextCursor: string }
  const cache = new Map<string, { etag: string; page: Page; bytes: number }>()
  let cacheBytes = 0,
    busy = false,
    repositoryId: number | undefined = expectedRepositoryId
  function selectedURL(value: unknown, host: string, expectedPath: string) {
    if (!bounded(value, 2048)) fail('INVALID_GITHUB_RESPONSE')
    let url: URL
    try {
      url = new URL(value)
    } catch {
      fail('INVALID_GITHUB_RESPONSE')
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[%@]/.test(value.slice(8).split('/')[0]!) ||
      url.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
      value.includes('#') ||
      value.includes('?') ||
      /[\\\s]/.test(value)
    )
      fail('INVALID_GITHUB_RESPONSE')
  }
  function convert(value: unknown): SourceEvent {
    if (
      !object(value) ||
      !Number.isSafeInteger(value.number) ||
      Number(value.number) < 1 ||
      !bounded(value.title, 2048) ||
      (value.state !== 'open' && value.state !== 'closed') ||
      !date(value.updated_at) ||
      typeof value.draft !== 'boolean' ||
      (value.created_at !== undefined && !date(value.created_at)) ||
      (value.closed_at !== undefined &&
        value.closed_at !== null &&
        !date(value.closed_at)) ||
      !(value.merged_at === null || date(value.merged_at)) ||
      (value.merged_at !== null && value.state !== 'closed') ||
      !object(value.base) ||
      !object(value.base.repo) ||
      !Number.isSafeInteger(value.base.repo.id) ||
      Number(value.base.repo.id) < 1 ||
      !repository(value.base.repo.full_name) ||
      value.base.repo.full_name.toLowerCase() !== selected ||
      !bounded(value.base.ref, 256) ||
      !bounded(value.base.sha, 64) ||
      !/^[a-f0-9]{40,64}$/i.test(value.base.sha) ||
      !object(value.head) ||
      !bounded(value.head.ref, 256) ||
      !bounded(value.head.label, 512) ||
      !bounded(value.head.sha, 64) ||
      !/^[a-f0-9]{40,64}$/i.test(value.head.sha) ||
      !(
        value.head.repo === null ||
        (object(value.head.repo) && repository(value.head.repo.full_name))
      )
    )
      fail('INVALID_GITHUB_RESPONSE')
    selectedURL(value.url, 'api.github.com', `${endpoint}/${value.number}`)
    selectedURL(
      value.html_url,
      'github.com',
      `/${owner}/${repo}/pull/${value.number}`,
    )
    if (repositoryId !== undefined && repositoryId !== value.base.repo.id)
      fail(
        expectedRepositoryId === undefined
          ? 'INVALID_GITHUB_RESPONSE'
          : 'GITHUB_REPOSITORY_CHANGED',
      )
    repositoryId = Number(value.base.repo.id)
    if(value.body !== undefined && value.body !== null && (typeof value.body !== 'string' || value.body.length > 40000 || /\0/.test(value.body)))fail('INVALID_GITHUB_RESPONSE')
    const text = JSON.stringify({
      kind: 'github-pull-request',
      ...(typeof value.body === 'string' ? {body:value.body} : {}),
      repository: selected,
      repositoryId: value.base.repo.id,
      number: value.number,
      title: value.title,
      url: value.html_url,
      ...(value.created_at !== undefined
        ? { createdAt: value.created_at }
        : {}),
      ...(value.closed_at !== undefined ? { closedAt: value.closed_at } : {}),
      state: value.merged_at !== null ? 'merged' : value.state,
      draft: value.draft,
      updatedAt: value.updated_at,
      mergedAt: value.merged_at,
      base: {
        repository: value.base.repo.full_name,
        ref: value.base.ref,
        sha: value.base.sha,
      },
      head: {
        repository:
          value.head.repo === null
            ? null
            : (value.head.repo as Record<string, unknown>).full_name,
        ref: value.head.ref,
        sha: value.head.sha,
        label: value.head.label,
      },
    })
    return parseSourceEvent({
      schemaVersion: 1,
      sourceInstanceId,
      externalId: `pr:${value.number}`,
      revision: `${value.updated_at}:${hash(text)}`,
      occurredAt: value.updated_at,
      role: 'tool',
      text,
    })
  }
  function nextLink(link: string | undefined, page: number): string {
    if (link === undefined) return ''
    if (link.length > 16384) fail('INVALID_GITHUB_RESPONSE')
    const next = link
      .split(',')
      .filter((part) => /;\s*rel="next"(?:\s*;|\s*$)/.test(part))
    if (next.length > 1) fail('INVALID_GITHUB_RESPONSE')
    if (!next.length) return ''
    const match = /^\s*<([^>]+)>;\s*rel="next"\s*$/.exec(next[0]!)
    if (!match) fail('INVALID_GITHUB_RESPONSE')
    let url: URL
    try {
      url = new URL(match[1]!)
    } catch {
      fail('INVALID_GITHUB_RESPONSE')
    }
    if (
      url.origin !== 'https://api.github.com' ||
      url.username ||
      url.password ||
      url.hash ||
      /[\\\s]/.test(match[1]!) ||
      ![
        endpoint.toLowerCase(),
        ...(repositoryId === undefined
          ? []
          : [`/repositories/${repositoryId}/pulls`]),
      ].includes(url.pathname.toLowerCase())
    )
      fail('INVALID_GITHUB_RESPONSE')
    const params = url.searchParams
    if (
      [...params.keys()].length !== 5 ||
      new Set(params.keys()).size !== 5 ||
      params.get('state') !== 'all' ||
      params.get('per_page') !== '100' ||
      params.get('sort') !== 'created' ||
      params.get('direction') !== 'asc' ||
      params.get('page') !== String(page + 1) ||
      page >= 10000
    )
      fail('INVALID_GITHUB_RESPONSE')
    return String(page + 1)
  }
  return async (cursor, signal) => {
    if (signal.aborted) fail('GITHUB_CANCELLED')
    if (busy) fail('GITHUB_BUSY')
    if (
      typeof cursor !== 'string' ||
      (cursor && (!/^[1-9]\d{0,4}$/.test(cursor) || Number(cursor) > 10000))
    )
      fail('INVALID_GITHUB_CURSOR')
    const page = Number(cursor || '1')
    const url = `https://api.github.com${endpoint}?${new URLSearchParams({ state: 'all', per_page: '100', sort: 'created', direction: 'asc', page: String(page) })}`
    const saved = cache.get(url)
    busy = true
    const priorRepositoryId = repositoryId
    try {
      if (expectedRepositoryId !== undefined) {
        const current = await verifyGithubRepository(
          token,
          owner,
          repo,
          transport,
          signal,
        )
        if (current !== expectedRepositoryId) fail('GITHUB_REPOSITORY_CHANGED')
      }
      const response = await transport({
        url,
        allowedDomain: 'api.github.com',
        bearerToken: token,
        signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
          ...(saved ? { 'If-None-Match': saved.etag } : {}),
        },
      })
      if (signal.aborted) fail('GITHUB_CANCELLED')
      checkGithubResponseStatus(response)
      if (response.status === 304) {
        if (!saved) fail('INVALID_GITHUB_RESPONSE')
        return structuredClone(saved.page)
      }
      if (response.status !== 200) fail('GITHUB_REQUEST_FAILED')
      if (!Array.isArray(response.body) || response.body.length > 100)
        fail('INVALID_GITHUB_RESPONSE')
      const events = response.body.map(convert)
      if (
        new Set(events.map((event) => event.externalId)).size !== events.length
      )
        fail('INVALID_GITHUB_RESPONSE')
      const result = {
        events,
        nextCursor: nextLink(header(response.headers, 'link'), page),
      }
      const etag = header(response.headers, 'etag')
      if (
        etag !== undefined &&
        !/^(?:W\/)?"[\x21\x23-\x7e]{1,1024}"$/.test(etag)
      )
        fail('INVALID_GITHUB_RESPONSE')
      if (saved) {
        cache.delete(url)
        cacheBytes -= saved.bytes
      }
      if (etag) {
        const bytes = Buffer.byteLength(JSON.stringify(result))
        while (cache.size >= 32 || cacheBytes + bytes > 8 * 1024 * 1024) {
          const key = cache.keys().next().value
          if (key === undefined) break
          cacheBytes -= cache.get(key)!.bytes
          cache.delete(key)
        }
        if (bytes <= 8 * 1024 * 1024) {
          cache.set(url, { etag, page: structuredClone(result), bytes })
          cacheBytes += bytes
        }
      }
      return result
    } catch (error) {
      repositoryId = priorRepositoryId
      if (signal.aborted) fail('GITHUB_CANCELLED')
      if (error instanceof GithubRateLimitError)
        throw new GithubRateLimitError(error.retryAfterMs)
      if (error instanceof GithubConnectorError)
        throw new GithubConnectorError(error.code)
      fail('GITHUB_REQUEST_FAILED')
    } finally {
      busy = false
    }
  }
}

import { it, expect } from 'vitest'
import {
  createGithubAccountFetcher,
  GithubRateLimitError,
  type SourceHttpTransport,
} from '@memo/connectors'
import {
  parseGithubAccountCursor,
  parseCoreRequest,
  parseHostRequest,
} from '@memo/contracts'
const signal = () => new AbortController().signal
const repo = {
  id: 7,
  full_name: 'Synthetic/Repo',
  html_url: 'https://github.com/Synthetic/Repo',
  updated_at: '2026-09-14T09:00:00Z',
  description: 'test',
}
const pr = {
  id: 10,
  number: 1,
  title: 'fix',
  body: 'details',
  state: 'closed',
  merged_at: '2026-09-14T09:00:00Z',
  updated_at: repo.updated_at,
  html_url: 'https://github.com/Synthetic/Repo/pull/1',
}
const issue = {
  id: 11,
  number: 2,
  title: 'bug',
  body: 'issue',
  state: 'open',
  updated_at: repo.updated_at,
  html_url: 'https://github.com/Synthetic/Repo/issues/2',
}
const comment = {
  id: 12,
  body: 'discussion',
  updated_at: repo.updated_at,
  html_url: 'https://github.com/Synthetic/Repo/issues/2#issuecomment-12',
  issue_url: 'https://api.github.com/repos/Synthetic/Repo/issues/2',
}
const review = {
  id: 13,
  body: 'review',
  updated_at: repo.updated_at,
  html_url: 'https://github.com/Synthetic/Repo/pull/1#discussion-diff-13',
  pull_request_url: 'https://api.github.com/repos/Synthetic/Repo/pulls/1',
}
function transport(override?: (url: string) => unknown): SourceHttpTransport {
  return async (r) => ({
    status: 200,
    headers: {},
    body:
      override?.(r.url) ??
      (r.url.endsWith('/user')
        ? { id: 42, login: 'synthetic' }
        : r.url.includes('/user/repos?')
          ? [repo]
          : r.url.endsWith('/repos/synthetic/repo')
            ? repo
            : r.url.includes('/pulls/comments?')
              ? [review]
              : r.url.includes('/issues/comments?')
                ? [comment]
                : r.url.includes('/pulls?')
                  ? [pr]
                  : [issue, { ...pr, pull_request: {} }]),
  })
}
it('discovers accessible repos and observes PRs, Issues and both comment families without double counting PR-as-Issue', async () => {
  const fetch = createGithubAccountFetcher('fixture', 42, transport())
  let cursor = ''
  const events = []
  do {
    const b = await fetch(cursor, signal())
    events.push(...b.events)
    cursor = b.nextCursor
  } while (cursor)
  expect(events).toHaveLength(5)
  expect(events.map((e) => JSON.parse(e.text).objectKind)).toEqual([
    'repository',
    'pull-request',
    'issue',
    'issue-comment',
    'review-comment',
  ])
  expect(new Set(events.map((e) => e.externalId)).size).toBe(5)
  expect(events.every((e) => e.role === 'tool')).toBe(true)
})
it('replays the same checkpoint deterministically and advances a full page only once', async () => {
  const fetch = createGithubAccountFetcher(
    'fixture',
    42,
    transport((url) =>
      url.includes('/pulls?')
        ? Array.from({ length: 50 }, (_, n) => ({
            ...pr,
            id: 100 + n,
            number: 100 + n,
            html_url: `https://github.com/Synthetic/Repo/pull/${100 + n}`,
          }))
        : undefined,
    ),
  )
  const first = await fetch('', signal()),
    retry = await fetch('', signal())
  expect(retry).toEqual(first)
  expect(parseGithubAccountCursor(first.nextCursor).page).toBe(2)
  expect(first.events).toHaveLength(51)
})
it('keeps revoked permissions, account substitution, rate limits and cancellation explicit', async () => {
  await expect(
    createGithubAccountFetcher('fixture', 43, transport())('', signal()),
  ).rejects.toThrow('GITHUB_AUTH_FAILED')
  await expect(
    createGithubAccountFetcher('fixture', 42, async () => ({
      status: 403,
      headers: {},
      body: {},
    }))('', signal()),
  ).rejects.toThrow('GITHUB_AUTH_FAILED')
  await expect(
    createGithubAccountFetcher('fixture', 42, async () => ({
      status: 429,
      headers: { 'retry-after': '10' },
      body: {},
    }))('', signal()),
  ).rejects.toBeInstanceOf(GithubRateLimitError)
  const c = new AbortController()
  c.abort()
  await expect(
    createGithubAccountFetcher('fixture', 42, transport())('', c.signal),
  ).rejects.toThrow('GITHUB_CANCELLED')
})
it('validates checkpoints and rejects foreign object URLs instead of following them', async () => {
  expect(() => parseGithubAccountCursor('{"v":1}')).toThrow()
  await expect(
    createGithubAccountFetcher(
      'fixture',
      42,
      transport((url) =>
        url.includes('/pulls?')
          ? [{ ...pr, html_url: 'https://evil.invalid/pull/1' }]
          : undefined,
      ),
    )('', signal()),
  ).rejects.toThrow()
  const method = {
    method: 'github.connectAccount',
    projectId: 'p',
    credentialId: '00000000-0000-4000-8000-000000000001',
  }
  expect(parseCoreRequest(method)).toEqual(method)
  expect(() => parseHostRequest(method)).toThrow()
})

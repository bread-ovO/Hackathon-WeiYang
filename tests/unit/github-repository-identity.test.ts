import { describe, expect, it, vi } from 'vitest'
import {
  createGithubPullRequestsFetcher,
  verifyGithubRepository,
  GithubRateLimitError,
} from '../../packages/connectors/src/github'
const signal = () => new AbortController().signal
const metadata = (id = 42) => ({
  status: 200,
  headers: {},
  body: { id, full_name: 'org/project' },
})
describe('selected GitHub numeric repository identity', () => {
  it('verifies empty repositories independently of PR observations', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce({ status: 200, headers: {}, body: [] })
    const pull = createGithubPullRequestsFetcher(
      'fictional',
      'org',
      'project',
      transport,
      42,
    )
    expect(await pull('', signal())).toEqual({ events: [], nextCursor: '' })
    expect(transport.mock.calls.map(([r]) => r.url)).toEqual([
      'https://api.github.com/repos/org/project',
      'https://api.github.com/repos/org/project/pulls?state=all&per_page=100&sort=created&direction=asc&page=1',
    ])
  })
  it('refuses replacement before accepting an empty PR list after restart', async () => {
    const transport = vi.fn().mockResolvedValue(metadata(43))
    await expect(
      createGithubPullRequestsFetcher(
        'fictional',
        'org',
        'project',
        transport,
        42,
      )('', signal()),
    ).rejects.toThrow('GITHUB_REPOSITORY_CHANGED')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it.each([401, 403, 404])(
    'classifies %i without rate headers as unavailable authorization',
    async (status) => {
      await expect(
        verifyGithubRepository(
          'fictional',
          'org',
          'project',
          vi.fn().mockResolvedValue({
            status,
            headers: {},
            body: { message: 'secret' },
          }),
          signal(),
        ),
      ).rejects.toThrow('GITHUB_AUTH_FAILED')
    },
  )
  it('recognizes explicit secondary rate limit without headers', async () => {
    const error = await verifyGithubRepository(
      'fictional',
      'org',
      'project',
      vi
        .fn()
        .mockResolvedValue({
          status: 403,
          headers: {},
          body: { message: 'You have exceeded a secondary rate limit.' },
        }),
      signal(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(GithubRateLimitError)
    expect(error.retryAfterMs).toBe(60000)
  })
  it.each([403, 429])('keeps explicit %i retry interval', async (status) => {
    const error = await verifyGithubRepository(
      'fictional',
      'org',
      'project',
      vi.fn().mockResolvedValue({
        status,
        headers: { 'retry-after': '180' },
        body: null,
      }),
      signal(),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(GithubRateLimitError)
    expect(error.retryAfterMs).toBe(180000)
  })
  it.each([
    { id: 42, full_name: 'else/project' },
    { id: -1, full_name: 'org/project' },
    { id: 42.5, full_name: 'org/project' },
    null,
  ])('rejects wrong or invalid metadata %j', async (body) => {
    await expect(
      verifyGithubRepository(
        'fictional',
        'org',
        'project',
        vi.fn().mockResolvedValue({ ...metadata(), body }),
        signal(),
      ),
    ).rejects.toThrow('INVALID_GITHUB_RESPONSE')
  })
  it('scrubs network errors and cancels before accepting metadata', async () => {
    await expect(
      verifyGithubRepository(
        'fictional',
        'org',
        'project',
        vi.fn().mockRejectedValue(Error('secret')),
        signal(),
      ),
    ).rejects.toThrow('GITHUB_REQUEST_FAILED')
    const controller = new AbortController()
    await expect(
      verifyGithubRepository(
        'fictional',
        'org',
        'project',
        async () => {
          controller.abort()
          return metadata()
        },
        controller.signal,
      ),
    ).rejects.toThrow('GITHUB_CANCELLED')
  })
})

import { createHash } from 'node:crypto'
import {
  parseGithubAccountCursor,
  parseGithubAccountObservation,
  parseSourceEvent,
  type GithubAccountObservation,
} from '@memo/contracts'
import {
  GithubConnectorError,
  checkGithubResponseStatus,
  type GithubPageFetcher,
  verifyGithubRepository,
} from './github'
import type { SourceHttpTransport } from './http-client'
const bad = (): never => {
  throw new GithubConnectorError('INVALID_GITHUB_RESPONSE')
}
async function request(
  path: string,
  token: string,
  transport: SourceHttpTransport,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new GithubConnectorError('GITHUB_CANCELLED')
  const r = await transport({
    url: `https://api.github.com${path}`,
    allowedDomain: 'api.github.com',
    bearerToken: token,
    signal,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
  })
  if (signal.aborted) throw new GithubConnectorError('GITHUB_CANCELLED')
  checkGithubResponseStatus(r)
  if (r.status !== 200) throw new GithubConnectorError('GITHUB_REQUEST_FAILED')
  return r.body
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad()
  return v as Record<string, unknown>
}
export async function verifyGithubAccount(
  token: string,
  transport: SourceHttpTransport,
  signal: AbortSignal,
) {
  const r = object(await request('/user', token, transport, signal))
  if (
    !Number.isSafeInteger(r.id) ||
    Number(r.id) < 1 ||
    typeof r.login !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(r.login)
  )
    return bad()
  return { id: Number(r.id), login: r.login.toLowerCase() }
}
/** Durable checkpoint advances only with a committed batch. A complete sweep restarts to discover new repos and revisions. */
export function createGithubAccountFetcher(
  token: string,
  accountId: number,
  transport: SourceHttpTransport,
): GithubPageFetcher {
  return async (raw, signal) => {
    let c
    try {
      c = parseGithubAccountCursor(raw)
    } catch {
      throw new GithubConnectorError('INVALID_GITHUB_CURSOR')
    }
    if ((await verifyGithubAccount(token, transport, signal)).id !== accountId)
      throw new GithubConnectorError('GITHUB_AUTH_FAILED')
    const repos = await request(
      `/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&direction=asc&per_page=100&page=${c.repositoryPage}`,
      token,
      transport,
      signal,
    )
    if (!Array.isArray(repos) || repos.length > 100) return bad()
    if (c.repositoryIndex >= repos.length) {
      if (repos.length < 100) return { events: [], nextCursor: '' }
      if (c.repositoryPage === 10000) return bad()
      return {
        events: [],
        nextCursor: JSON.stringify({
          ...c,
          repositoryPage: c.repositoryPage + 1,
          repositoryIndex: 0,
          kind: 0,
          page: 1,
        }),
      }
    }
    const repo = object(repos[c.repositoryIndex])
    if (
      typeof repo.full_name !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/i.test(repo.full_name) ||
      !Number.isSafeInteger(repo.id)
    )
      return bad()
    const name = repo.full_name.toLowerCase(),
      [owner, repository] = name.split('/')
    try {
      if (
        (await verifyGithubRepository(
          token,
          owner!,
          repository!,
          transport,
          signal,
        )) !== repo.id
      )
        throw new GithubConnectorError('GITHUB_REPOSITORY_CHANGED')
      const paths = [
        'pulls?state=all&sort=updated&direction=asc',
        'issues?state=all&sort=updated&direction=asc',
        'issues/comments?sort=updated&direction=asc',
        'pulls/comments?sort=updated&direction=asc',
      ]
      const data = await request(
        `/repos/${name}/${paths[c.kind]}&per_page=50&page=${c.page}`,
        token,
        transport,
        signal,
      )
      if (!Array.isArray(data) || data.length > 50) return bad()
      const payloads: GithubAccountObservation[] = []
      function observation(
        r: Record<string, unknown>,
        objectKind: GithubAccountObservation['objectKind'],
      ) {
        if (
          typeof r.updated_at !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.updated_at) ||
          !Number.isFinite(Date.parse(r.updated_at)) ||
          new Date(r.updated_at).toISOString().replace('.000Z', 'Z') !==
            r.updated_at
        )
          return bad()
        let number = r.number ?? null
        if (objectKind.endsWith('comment')) {
          const link =
            objectKind === 'issue-comment' ? r.issue_url : r.pull_request_url
          if (typeof link !== 'string') return bad()
          const m = new RegExp(
            `^https://api\\.github\\.com/repos/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?:issues|pulls)/([1-9][0-9]*)$`,
            'i',
          ).exec(link)
          if (!m) return bad()
          number = Number(m[1])
        }
        payloads.push(
          parseGithubAccountObservation({
            kind: 'github-account-observation',
            objectKind,
            repository: name,
            repositoryId: repo.id,
            objectId: r.id,
            number,
            title: r.title ?? (objectKind === 'repository' ? name : ''),
            body:
              r.body ??
              (objectKind === 'repository' ? (r.description ?? '') : ''),
            state: r.merged_at ? 'merged' : (r.state ?? null),
            url: r.html_url,
            updatedAt: new Date(r.updated_at).toISOString(),
          }),
        )
      }
      if (c.kind === 0 && c.page === 1) observation(repo, 'repository')
      for (const value of data) {
        const r = object(value)
        if (c.kind === 1 && r.pull_request) continue
        observation(
          r,
          (
            [
              'pull-request',
              'issue',
              'issue-comment',
              'review-comment',
            ] as const
          )[c.kind]!,
        )
      }
      const events = payloads.map((p) => {
        const text = JSON.stringify(p)
        return parseSourceEvent({
          schemaVersion: 1,
          sourceInstanceId: 'github-account',
          externalId: `repo:${p.repositoryId}:${p.objectKind}:${p.objectId}`,
          revision: createHash('sha256').update(text).digest('hex'),
          role: 'tool',
          text,
          occurredAt: p.updatedAt,
        })
      })
      if (data.length === 50) {
        if (c.page === 10000) return bad()
        c.page++
      } else if (c.kind < 3) {
        c.kind++
        c.page = 1
      } else {
        c.repositoryIndex++
        c.kind = 0
        c.page = 1
      }
      return { events, nextCursor: JSON.stringify(c) }
    } catch (error) {
      if (
        error instanceof GithubConnectorError &&
        !['GITHUB_RATE_LIMITED', 'GITHUB_CANCELLED'].includes(error.code)
      )
        throw new GithubConnectorError(error.code, name)
      throw error
    }
  }
}

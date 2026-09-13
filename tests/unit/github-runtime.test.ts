import { describe, it, expect, vi } from 'vitest'
import type { GithubAuthorized, HostRequest, CoreReply } from '@memo/contracts'
import type { SourceHttpTransport } from '@memo/connectors'
import { createGithubRuntime } from '../../apps/desktop/src/main/github-runtime'
const id = '00000000-0000-4000-8000-000000000001',
  credentialId = '00000000-0000-4000-8000-000000000002'
function fixture() {
  let time = 1_000_000,
    paused = false
  const connections: GithubAuthorized[] = [
    {
      id,
      credentialId,
      projectId: 'project',
      owner: 'org',
      repo: 'project',
      repositoryId: 123,
      grantVersion: 1,
      pollVersion: 1,
      status: 'active',
      nextPollAt: 0,
      lastSuccessAt: null,
      errorCode: null,
      failureCount: 0,
      eventCount: 0,
      cursor: '',
      enabled: true,
      revoked: false,
    },
  ]
  const cooldowns = new Map<
    string,
    { notBefore: number; failureCount: number }
  >()
  const summary = (x: GithubAuthorized) => {
    const { cursor, enabled, revoked, ...rest } = x
    return rest
  }
  const request = vi.fn(async (r: HostRequest): Promise<CoreReply<unknown>> => {
    const c = connections.find((x) => 'id' in r && x.id === r.id)!
    switch (r.method) {
      case 'githubHost.getCooldown':
        return {
          ok: true,
          data: cooldowns.get(r.credentialId) ?? {
            notBefore: 0,
            failureCount: 0,
          },
        }
      case 'githubHost.recordCooldown': {
        const old = cooldowns.get(r.credentialId) ?? {
          notBefore: 0,
          failureCount: 0,
        }
        const next = {
          notBefore: Math.max(old.notBefore, r.notBefore),
          failureCount: old.failureCount + 1,
        }
        cooldowns.set(r.credentialId, next)
        return { ok: true, data: next }
      }
      case 'githubHost.list':
        return { ok: true, data: connections.map(summary) }
      case 'githubHost.get':
        return { ok: true, data: c }
      case 'ingestion.status':
        return {
          ok: true,
          data: { paused, reason: paused ? 'queue_limit' : null },
        }
      case 'githubHost.authorize':
        connections.push({ ...connections[0]!, ...r.input, id: 'new-source' })
        return { ok: true, data: summary(connections.at(-1)!) }
      case 'githubHost.receiveBatch':
        if (
          c.pollVersion !== r.expectedPollVersion ||
          c.grantVersion !== r.expectedGrantVersion ||
          c.cursor !== r.expectedCursor ||
          !c.enabled
        )
          return { ok: false, error: 'GITHUB_UNAVAILABLE' }
        c.pollVersion++
        c.cursor = r.nextCursor
        c.nextPollAt = r.nextPollAt
        c.eventCount += r.events.length
        c.failureCount = 0
        c.errorCode = null
        return {
          ok: true,
          data: {
            inserted: r.events.length,
            duplicates: 0,
            connection: summary(c),
          },
        }
      case 'githubHost.recordFailure':
        if (
          c.pollVersion !== r.expectedPollVersion ||
          c.grantVersion !== r.expectedGrantVersion ||
          c.cursor !== r.expectedCursor ||
          !c.enabled
        )
          return { ok: true, data: false }
        c.pollVersion++
        c.errorCode = r.errorCode
        c.nextPollAt = r.nextPollAt
        c.failureCount++
        return { ok: true, data: true }
      case 'githubHost.setEnabled':
        c.enabled = r.enabled
        c.status = r.enabled ? 'active' : 'paused'
        c.grantVersion++
        c.pollVersion++
        return { ok: true, data: summary(c) }
      case 'githubHost.revoke':
        c.enabled = false
        c.revoked = true
        c.status = 'revoked'
        c.grantVersion++
        c.pollVersion++
        return { ok: true, data: summary(c) }
      default:
        throw Error(r.method)
    }
  })
  const transport = vi.fn<SourceHttpTransport>(async (input) => ({
    status: 200,
    headers: {},
    body: input.url.includes('/pulls?')
      ? []
      : { id: 123, full_name: 'org/project' },
  }))
  const readCredential = vi.fn(
    async (_id: string, _scope: { domain: string; purpose: 'source' }) =>
      'synthetic-token',
  )
  const deps = { request, transport, readCredential, now: () => time }
  return {
    connections,
    request,
    transport,
    readCredential,
    deps,
    runtime: createGithubRuntime(deps),
    setTime: (n: number) => {
      time = n
    },
    pressure: () => {
      paused = true
    },
  }
}
describe('GitHub host runtime with actual provider adapter and synthetic HTTP', () => {
  it('verifies metadata and PR permission before authorizing; each actual request reads vault', async () => {
    const f = fixture()
    const result = await f.runtime.handle({
      method: 'github.connect',
      projectId: 'project',
      owner: 'Org',
      repo: 'Project',
      credentialId,
    })
    expect(result.ok).toBe(true)
    expect(f.transport).toHaveBeenCalledTimes(3)
    expect(f.readCredential).toHaveBeenCalledTimes(3)
    expect(
      f.transport.mock.calls.every(
        ([r]) =>
          r.bearerToken === 'synthetic-token' &&
          r.allowedDomain === 'api.github.com',
      ),
    ).toBe(true)
    expect(
      f.request.mock.calls.find(
        ([r]) => r.method === 'githubHost.authorize',
      )?.[0],
    ).toMatchObject({
      input: { owner: 'org', repo: 'project', repositoryId: 123 },
    })
    expect(JSON.stringify(result)).not.toContain('synthetic-token')
    expect(JSON.stringify(result)).not.toContain('cursor')
  })
  it('does not authorize when metadata works but PR access fails', async () => {
    const f = fixture()
    f.transport.mockImplementation(async (r) => ({
      status: r.url.includes('/pulls?') ? 403 : 200,
      headers: {},
      body: { id: 123, full_name: 'org/project' },
    }))
    expect(
      await f.runtime.handle({
        method: 'github.connect',
        projectId: 'project',
        owner: 'org',
        repo: 'project',
        credentialId,
      }),
    ).toEqual({ ok: false, error: 'GITHUB_AUTH_FAILED' })
    expect(
      f.request.mock.calls.some(([r]) => r.method === 'githubHost.authorize'),
    ).toBe(false)
  })
  it('persists completed due across runtime restart and manual sync', async () => {
    const f = fixture()
    await f.runtime.tick()
    expect(f.connections[0]!.nextPollAt).toBe(1_300_000)
    const restart = createGithubRuntime(f.deps)
    await restart.tick()
    expect(await restart.handle({ method: 'github.sync', id })).toEqual({
      ok: false,
      error: 'GITHUB_NOT_DUE',
    })
    expect(f.transport).toHaveBeenCalledTimes(2)
    f.setTime(1_300_000)
    await restart.tick()
    expect(f.transport).toHaveBeenCalledTimes(4)
  })
  it('persists rate retry without shortening it on pause/resume or restart', async () => {
    const f = fixture()
    f.transport.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '7200' },
      body: null,
    })
    expect(await f.runtime.handle({ method: 'github.sync', id })).toEqual({
      ok: false,
      error: 'GITHUB_RATE_LIMITED',
    })
    expect(f.connections[0]!.nextPollAt).toBe(8_200_000)
    await f.runtime.handle({ method: 'github.setEnabled', id, enabled: false })
    await f.runtime.handle({ method: 'github.setEnabled', id, enabled: true })
    await createGithubRuntime(f.deps).tick()
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it('preflights quota without reading credentials or disabling processing eligibility', async () => {
    const f = fixture()
    f.pressure()
    await f.runtime.tick()
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.readCredential).not.toHaveBeenCalled()
    expect(f.connections[0]).toMatchObject({
      enabled: true,
      nextPollAt: 1_060_000,
      errorCode: 'INGESTION_QUEUE_LIMIT',
      cursor: '',
    })
  })
  it('fences late responses after pause and rejects overlapping sync', async () => {
    const f = fixture()
    let release!: (value: Awaited<ReturnType<SourceHttpTransport>>) => void
    f.transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = f.runtime.handle({ method: 'github.sync', id })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(await f.runtime.handle({ method: 'github.sync', id })).toEqual({
      ok: false,
      error: 'GITHUB_BUSY',
    })
    await f.runtime.handle({ method: 'github.setEnabled', id, enabled: false })
    release({
      status: 200,
      headers: {},
      body: { id: 123, full_name: 'org/project' },
    })
    expect(await pending).toEqual({ ok: false, error: 'GITHUB_CANCELLED' })
    expect(
      f.request.mock.calls.some(
        ([r]) =>
          r.method === 'githubHost.receiveBatch' ||
          r.method === 'githubHost.recordFailure',
      ),
    ).toBe(false)
  })
  it('stop permanently prevents new work and cancels pending connect', async () => {
    const f = fixture()
    let release!: (token: string) => void
    f.readCredential.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = f.runtime.handle({
      method: 'github.connect',
      projectId: 'project',
      owner: 'org',
      repo: 'project',
      credentialId,
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.runtime.stop()
    release('synthetic-token')
    expect(await pending).toEqual({ ok: false, error: 'GITHUB_CANCELLED' })
    await f.runtime.tick()
    expect(f.transport).not.toHaveBeenCalled()
    expect(await f.runtime.handle({ method: 'github.list' })).toEqual({
      ok: false,
      error: 'GITHUB_UNAVAILABLE',
    })
  })
  it('bounds each tick at four connections and advances due order fairly', async () => {
    const f = fixture()
    for (let i = 2; i <= 6; i++)
      f.connections.push({
        ...f.connections[0]!,
        id: `source-${i}`,
        credentialId: `credential-${i}`,
      })
    await f.runtime.tick()
    expect(f.connections.filter((x) => x.nextPollAt > 0)).toHaveLength(4)
    await f.runtime.tick()
    expect(f.connections.filter((x) => x.nextPollAt > 0)).toHaveLength(6)
  })
  it('scrubs thrown credential errors and retries with bounded exponential backoff', async () => {
    const f = fixture()
    f.readCredential.mockRejectedValue(new Error('secret-token /private/path'))
    expect(await f.runtime.handle({ method: 'github.sync', id })).toEqual({
      ok: false,
      error: 'GITHUB_CREDENTIAL_UNAVAILABLE',
    })
    expect(f.connections[0]).toMatchObject({
      errorCode: 'GITHUB_CREDENTIAL_UNAVAILABLE',
      nextPollAt: 1_030_000,
    })
  })
  it('pauses only the removed credential and holds the fence until removal settles', async () => {
    const f = fixture()
    f.connections.push({
      ...f.connections[0]!,
      id: 'other',
      credentialId: 'other-credential',
    })
    let release!: (reply: CoreReply<unknown>) => void
    const remove = vi.fn(
      () =>
        new Promise<CoreReply<unknown>>((resolve) => {
          release = resolve
        }),
    )
    const pending = f.runtime.removeCredential(credentialId, remove)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    expect(f.connections[0]).toMatchObject({ enabled: false, grantVersion: 2 })
    expect(f.connections[1]).toMatchObject({ enabled: true, grantVersion: 1 })
    expect(
      await f.runtime.handle({
        method: 'github.setEnabled',
        id,
        enabled: true,
      }),
    ).toEqual({ ok: false, error: 'GITHUB_BUSY' })
    expect(
      await f.runtime.handle({
        method: 'github.connect',
        projectId: 'project',
        owner: 'org',
        repo: 'project',
        credentialId,
      }),
    ).toEqual({ ok: false, error: 'GITHUB_BUSY' })
    release({ ok: false, error: 'VAULT_WRITE_FAILED' })
    expect(await pending).toEqual({ ok: false, error: 'VAULT_WRITE_FAILED' })
    expect(f.connections[0]!.enabled).toBe(false)
  })
  it('preserves cursor and eligibility on an atomic receive quota failure', async () => {
    const f = fixture()
    const original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (request) =>
      request.method === 'githubHost.receiveBatch'
        ? { ok: false, error: 'INGESTION_DATABASE_LIMIT' }
        : original(request),
    )
    expect(await f.runtime.handle({ method: 'github.sync', id })).toEqual({
      ok: false,
      error: 'INGESTION_DATABASE_LIMIT',
    })
    expect(f.connections[0]).toMatchObject({
      cursor: '',
      enabled: true,
      nextPollAt: 1_060_000,
      errorCode: 'INGESTION_DATABASE_LIMIT',
    })
  })
  it('persists continuation and only commits one page per tick with a CAS fence', async () => {
    const f = fixture()
    f.transport.mockImplementation(async (input) => ({
      status: 200,
      headers: input.url.includes('/pulls?')
        ? {
            link: '<https://api.github.com/repos/org/project/pulls?state=all&sort=created&direction=asc&per_page=100&page=2>; rel="next"',
          }
        : ({} as Record<string, string>),
      body: input.url.includes('/pulls?')
        ? []
        : { id: 123, full_name: 'org/project' },
    }))
    await f.runtime.tick()
    expect(f.connections[0]!.cursor).not.toBe('')
    expect(f.connections[0]!.nextPollAt).toBe(1_001_000)
    const commits = f.request.mock.calls
      .map(([r]) => r)
      .filter((r) => r.method === 'githubHost.receiveBatch')
    expect(commits).toHaveLength(1)
    expect(commits[0]).toMatchObject({
      expectedCursor: '',
      expectedGrantVersion: 1,
    })
    await createGithubRuntime(f.deps).tick()
    expect(f.transport).toHaveBeenCalledTimes(2)
  })
  it('waits for cancelled connect to settle before removing its credential', async () => {
    const f = fixture()
    let release!: (value: Awaited<ReturnType<SourceHttpTransport>>) => void
    f.transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const connect = f.runtime.handle({
      method: 'github.connect',
      projectId: 'project',
      owner: 'org',
      repo: 'project',
      credentialId,
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const remove = vi.fn(
      async (): Promise<CoreReply<unknown>> => ({ ok: true, data: {} }),
    )
    const removal = f.runtime.removeCredential(credentialId, remove)
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()
    release({
      status: 200,
      headers: {},
      body: { id: 123, full_name: 'org/project' },
    })
    expect(await connect).toEqual({ ok: false, error: 'GITHUB_CANCELLED' })
    expect((await removal).ok).toBe(true)
    expect(
      f.request.mock.calls.some(([r]) => r.method === 'githubHost.authorize'),
    ).toBe(false)
    expect(f.connections[0]!.enabled).toBe(false)
  })
  it('backs off repeated limits while preserving server lower bounds', async () => {
    const f = fixture()
    f.connections[0]!.failureCount = 5
    for (let i = 0; i < 5; i++)
      await f.request({
        method: 'githubHost.recordCooldown',
        credentialId,
        notBefore: 0,
      })
    f.transport.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '1' },
      body: null,
    })
    await f.runtime.tick()
    expect(f.connections[0]!.nextPollAt).toBe(1_960_000)
  })
  it('commits a validated PR observation under the installed source, not a task completion', async () => {
    const f = fixture()
    const pr = {
      number: 1,
      title: 'Synthetic merged change',
      html_url: 'https://github.com/org/project/pull/1',
      url: 'https://api.github.com/repos/org/project/pulls/1',
      state: 'closed',
      merged_at: '2026-09-13T00:00:00Z',
      updated_at: '2026-09-13T00:00:00Z',
      draft: false,
      base: {
        ref: 'main',
        sha: 'a'.repeat(40),
        repo: { id: 123, full_name: 'org/project' },
      },
      head: {
        ref: 'feature',
        sha: 'b'.repeat(40),
        label: 'fork:feature',
        repo: { full_name: 'fork/project' },
      },
    }
    f.transport.mockImplementation(async (input) => ({
      status: 200,
      headers: {},
      body: input.url.includes('/pulls?')
        ? [pr]
        : { id: 123, full_name: 'org/project' },
    }))
    await f.runtime.tick()
    const commit = f.request.mock.calls
      .map(([r]) => r)
      .find((r) => r.method === 'githubHost.receiveBatch')!
    expect(commit).toMatchObject({
      expectedPollVersion: 1,
      expectedGrantVersion: 1,
      expectedCursor: '',
      events: [{ sourceInstanceId: id, externalId: 'pr:1', role: 'tool' }],
    })
    expect(f.connections[0]!.eventCount).toBe(1)
    expect(
      f.request.mock.calls.some(([r]) => r.method.startsWith('workspace.')),
    ).toBe(false)
  })
  it('reuses real polling ETags but drops conditional authorization on token rotation', async () => {
    const f = fixture()
    let token = 'synthetic-a'
    f.readCredential.mockImplementation(async () => token)
    const pageHeaders: Record<string, string>[] = []
    f.transport.mockImplementation(
      async (input): Promise<Awaited<ReturnType<SourceHttpTransport>>> => {
        if (!input.url.includes('/pulls?'))
          return {
            status: 200,
            headers: {},
            body: { id: 123, full_name: 'org/project' },
          }
        pageHeaders.push({ ...input.headers })
        if (input.headers?.['If-None-Match'])
          return { status: 304, headers: {}, body: null }
        return { status: 200, headers: { etag: '"page-v1"' }, body: [] }
      },
    )
    await f.runtime.tick()
    f.setTime(1_300_000)
    await f.runtime.tick()
    expect(pageHeaders).toHaveLength(2)
    expect(pageHeaders[1]).toMatchObject({ 'If-None-Match': '"page-v1"' })
    token = 'synthetic-b'
    f.setTime(1_600_000)
    await f.runtime.tick()
    expect(pageHeaders[2]).not.toHaveProperty('If-None-Match')
    expect(f.connections[0]).toMatchObject({ errorCode: null, pollVersion: 4 })
    expect(f.readCredential).toHaveBeenCalledTimes(6)
    await f.runtime.handle({ method: 'github.setEnabled', id, enabled: false })
    await f.runtime.handle({ method: 'github.setEnabled', id, enabled: true })
    f.setTime(1_900_000)
    await f.runtime.tick()
    expect(pageHeaders[3]).not.toHaveProperty('If-None-Match')
  })
  it('attributes cached-reader credential failures to the current pull', async () => {
    const f = fixture()
    await f.runtime.tick()
    f.readCredential.mockRejectedValue(new Error('synthetic-private-failure'))
    f.setTime(1_300_000)
    expect(await f.runtime.handle({ method: 'github.sync', id })).toEqual({
      ok: false,
      error: 'GITHUB_CREDENTIAL_UNAVAILABLE',
    })
    expect(f.connections[0]!.errorCode).toBe('GITHUB_CREDENTIAL_UNAVAILABLE')
  })
  it('persists first-connect rate limits across clicks and restarts', async () => {
    const f = fixture()
    f.transport.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '120' },
      body: null,
    })
    const connect = {
      method: 'github.connect' as const,
      projectId: 'project',
      owner: 'org',
      repo: 'project',
      credentialId,
    }
    expect(await f.runtime.handle(connect)).toEqual({
      ok: false,
      error: 'GITHUB_RATE_LIMITED',
    })
    expect(await f.runtime.handle(connect)).toEqual({
      ok: false,
      error: 'GITHUB_NOT_DUE',
    })
    const restarted = createGithubRuntime(f.deps)
    expect(await restarted.handle(connect)).toEqual({
      ok: false,
      error: 'GITHUB_NOT_DUE',
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(
      f.request.mock.calls.filter(
        ([r]) => r.method === 'githubHost.recordCooldown',
      ),
    ).toHaveLength(1)
    f.setTime(1_120_000)
    expect(await restarted.handle(connect)).toEqual({
      ok: false,
      error: 'GITHUB_RATE_LIMITED',
    })
    expect(f.transport).toHaveBeenCalledTimes(2)
  })
  it('shares credential cooldown across installed connections without increasing its count', async () => {
    const f = fixture()
    f.connections.push({ ...f.connections[0]!, id: 'second' })
    f.transport.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '120' },
      body: null,
    })
    await f.runtime.handle({ method: 'github.sync', id })
    expect(
      await f.runtime.handle({ method: 'github.sync', id: 'second' }),
    ).toEqual({ ok: false, error: 'GITHUB_RATE_LIMITED' })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.connections[1]).toMatchObject({
      nextPollAt: 1_120_000,
      errorCode: 'GITHUB_RATE_LIMITED',
    })
    expect(
      f.request.mock.calls.filter(
        ([r]) => r.method === 'githubHost.recordCooldown',
      ),
    ).toHaveLength(1)
  })
  it('fails closed when persisted cooldown cannot be read', async () => {
    const f = fixture(),
      original = f.request.getMockImplementation()!
    f.request.mockImplementation(async (r) =>
      r.method === 'githubHost.getCooldown'
        ? { ok: false, error: 'CORE_UNAVAILABLE' }
        : original(r),
    )
    await f.runtime.handle({
      method: 'github.connect',
      projectId: 'project',
      owner: 'org',
      repo: 'project',
      credentialId,
    })
    await f.runtime.handle({ method: 'github.sync', id })
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.readCredential).not.toHaveBeenCalled()
  })
  it('snapshots connect scope before awaiting external work', async () => {
    const f = fixture()
    let release!: (value: Awaited<ReturnType<SourceHttpTransport>>) => void
    const original = f.transport.getMockImplementation()!
    f.transport
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      .mockImplementation(original)
    const request = {
      method: 'github.connect' as const,
      projectId: 'project',
      owner: 'org',
      repo: 'project',
      credentialId,
    }
    const pending = f.runtime.handle(request)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    request.projectId = 'attacker-project'
    request.credentialId = 'attacker-credential'
    release({
      status: 200,
      headers: {},
      body: { id: 123, full_name: 'org/project' },
    })
    expect((await pending).ok).toBe(true)
    expect(
      f.request.mock.calls.find(
        ([r]) => r.method === 'githubHost.authorize',
      )?.[0],
    ).toMatchObject({ input: { projectId: 'project', credentialId } })
    expect(
      f.readCredential.mock.calls.every((args) => args[0] === credentialId),
    ).toBe(true)
  })
})

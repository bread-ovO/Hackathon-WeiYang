import { describe, it, expect, vi } from 'vitest'
import type { CoreReply, HostRequest, FeishuAuthorized } from '@memo/contracts'
import type { SourceHttpTransport } from '@memo/connectors'
import { createFeishuRuntime } from '../../apps/desktop/src/main/feishu-runtime'
const T = Date.parse('2026-09-15T00:00:00Z'),
  DAY = 86_400_000,
  id = '00000000-0000-4000-8000-000000000001',
  credentialId = '00000000-0000-4000-8000-000000000002'
function fixture() {
  let time = T,
    pressure = false
  const connections: FeishuAuthorized[] = [
    {
      id,
      projectId: 'project',
      chatId: 'oc_synthetic',
      credentialId,
      grantVersion: 1,
      pollVersion: 1,
      status: 'active',
      startTime: T - 2 * DAY,
      completedThrough: null,
      nextPollAt: 0,
      lastSuccessAt: null,
      errorCode: null,
      failureCount: 0,
      eventCount: 0,
      enabled: true,
      revoked: false,
      pageToken: '',
      windowStart: T - 2 * DAY,
      windowEnd: T - DAY,
      windowActive: true,
    },
  ]
  const cooldowns = new Map<
    string,
    { notBefore: number; failureCount: number }
  >()
  const summary = (x: FeishuAuthorized) => {
    const {
      enabled,
      revoked,
      pollVersion,
      pageToken,
      windowStart,
      windowEnd,
      windowActive,
      ...rest
    } = x
    return rest
  }
  const request = vi.fn(async (r: HostRequest): Promise<CoreReply<unknown>> => {
    const c = connections.find((x) => 'id' in r && x.id === r.id)!
    switch (r.method) {
      case 'feishuHost.list':
        return { ok: true, data: connections.map(summary) }
      case 'feishuHost.get':
        return { ok: true, data: c }
      case 'feishuHost.getCooldown':
        return {
          ok: true,
          data: cooldowns.get(r.credentialId) ?? {
            notBefore: 0,
            failureCount: 0,
          },
        }
      case 'feishuHost.recordCooldown': {
        const old = cooldowns.get(r.credentialId) ?? {
          notBefore: 0,
          failureCount: 0,
        }
        const value = {
          notBefore: Math.max(old.notBefore, r.notBefore),
          failureCount: old.failureCount + 1,
        }
        cooldowns.set(r.credentialId, value)
        return { ok: true, data: value }
      }
      case 'ingestion.status':
        return {
          ok: true,
          data: { paused: pressure, reason: pressure ? 'queue_limit' : null },
        }
      case 'feishuHost.authorize':
        connections.push({
          ...connections[0]!,
          ...r.input,
          id: 'new-source',
          windowStart: r.input.startTime,
          windowEnd: Math.min(r.input.startTime + DAY, r.input.endTime),
        })
        return { ok: true, data: summary(connections.at(-1)!) }
      case 'feishuHost.beginWindow':
        if (
          c.pollVersion !== r.expectedPollVersion ||
          c.grantVersion !== r.expectedGrantVersion ||
          !c.enabled
        )
          return { ok: false, error: 'FEISHU_UNAVAILABLE' }
        c.windowStart = Math.max(c.startTime, c.completedThrough! - 120_000)
        c.windowEnd = Math.min(c.completedThrough! + DAY, r.until)
        c.windowActive = true
        c.pageToken = ''
        c.errorCode = null
        c.status = 'active'
        c.pollVersion++
        return { ok: true, data: c }
      case 'feishuHost.restartWindow':
        c.pageToken = ''
        c.errorCode = null
        c.status = 'active'
        c.pollVersion++
        c.nextPollAt = Math.max(c.nextPollAt, time + 30_000)
        return { ok: true, data: c }
      case 'feishuHost.receiveBatch':
        if (
          c.pollVersion !== r.expectedPollVersion ||
          c.grantVersion !== r.expectedGrantVersion ||
          c.pageToken !== r.expectedPageToken ||
          !c.enabled
        )
          return { ok: false, error: 'FEISHU_UNAVAILABLE' }
        c.pollVersion++
        c.pageToken = r.nextPageToken
        c.nextPollAt = r.nextPollAt
        c.eventCount += r.events.length
        c.errorCode = null
        c.failureCount = 0
        if (!r.nextPageToken) {
          c.completedThrough = c.windowEnd
          c.windowActive = false
        }
        return {
          ok: true,
          data: {
            inserted: r.events.length,
            duplicates: 0,
            connection: summary(c),
          },
        }
      case 'feishuHost.recordFailure':
        if (
          c.pollVersion !== r.expectedPollVersion ||
          c.grantVersion !== r.expectedGrantVersion ||
          !c.enabled
        )
          return { ok: true, data: false }
        c.pollVersion++
        c.errorCode = r.errorCode
        c.failureCount++
        c.nextPollAt = Math.max(c.nextPollAt, r.nextPollAt)
        return { ok: true, data: true }
      case 'feishuHost.setEnabled':
        c.enabled = r.enabled
        c.status = r.enabled ? 'active' : 'paused'
        c.grantVersion++
        c.pollVersion++
        return { ok: true, data: summary(c) }
      case 'feishuHost.revoke':
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
  const transport = vi.fn<SourceHttpTransport>(async () => ({
    status: 200,
    headers: {},
    body: { code: 0, data: { items: [], has_more: false } },
  }))
  const readCredential = vi.fn(
    async (_id: string, _scope: { domain: string; purpose: 'source' }) =>
      'synthetic-token',
  )
  const deps = { request, transport, readCredential, now: () => time }
  return {
    deps,
    runtime: createFeishuRuntime(deps),
    connections,
    transport,
    request,
    readCredential,
    setTime: (v: number) => {
      time = v
    },
    pressure: () => {
      pressure = true
    },
  }
}
const connect = {
  method: 'feishu.connect' as const,
  projectId: 'project',
  chatId: 'oc_synthetic',
  credentialId,
  startTime: T - 2 * DAY,
}
describe('Feishu durable host runtime with actual adapter and synthetic transport', () => {
  it('verifies a fixed selected first window before authorization and never sends tokens to core', async () => {
    const f = fixture()
    expect((await f.runtime.handle(connect)).ok).toBe(true)
    const input = f.transport.mock.calls[0]![0],
      url = new URL(input.url)
    expect(url.origin).toBe('https://open.feishu.cn')
    expect(url.searchParams.get('container_id')).toBe('oc_synthetic')
    expect(url.searchParams.get('start_time')).toBe(
      String((T - 2 * DAY) / 1000),
    )
    expect(url.searchParams.get('end_time')).toBe(String((T - DAY) / 1000))
    expect(url.searchParams.get('sort_type')).toBe('ByCreateTimeAsc')
    expect(f.readCredential).toHaveBeenCalledWith(credentialId, {
      domain: 'open.feishu.cn',
      purpose: 'source',
    })
    expect(
      f.request.mock.calls.find(
        ([r]) => r.method === 'feishuHost.authorize',
      )?.[0],
    ).toMatchObject({
      input: {
        projectId: connect.projectId,
        chatId: connect.chatId,
        credentialId,
        startTime: connect.startTime,
        endTime: T,
      },
    })
    expect(JSON.stringify(f.request.mock.calls)).not.toContain(
      'synthetic-token',
    )
  })
  it('keeps the fixed interval while paging across runtime restart', async () => {
    const f = fixture()
    f.transport.mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: {
        code: 0,
        data: { items: [], has_more: true, page_token: 'page-A' },
      },
    })
    await f.runtime.tick()
    expect(f.connections[0]).toMatchObject({
      pageToken: 'page-A',
      windowActive: true,
      completedThrough: null,
      nextPollAt: T + 1000,
    })
    const restarted = createFeishuRuntime(f.deps)
    await restarted.tick()
    expect(f.transport).toHaveBeenCalledTimes(1)
    f.setTime(T + 1000)
    await restarted.tick()
    const first = new URL(f.transport.mock.calls[0]![0].url),
      second = new URL(f.transport.mock.calls[1]![0].url)
    expect(second.searchParams.get('page_token')).toBe('page-A')
    expect(second.searchParams.get('start_time')).toBe(
      first.searchParams.get('start_time'),
    )
    expect(second.searchParams.get('end_time')).toBe(
      first.searchParams.get('end_time'),
    )
    expect(f.connections[0]).toMatchObject({
      pageToken: '',
      windowActive: false,
      completedThrough: T - DAY,
    })
  })
  it('advances an empty completed window with overlap and a fresh poll CAS', async () => {
    const f = fixture()
    await f.runtime.tick()
    f.setTime(T + 1000)
    await f.runtime.tick()
    expect(f.connections[0]).toMatchObject({
      windowStart: T - DAY - 120_000,
      windowEnd: T,
      completedThrough: T,
      pollVersion: 4,
    })
    const commits = f.request.mock.calls
      .map(([r]) => r)
      .filter((r) => r.method === 'feishuHost.receiveBatch')
    expect(commits[1]).toMatchObject({
      expectedPollVersion: 3,
      expectedWindowStart: T - DAY - 120_000,
      expectedWindowEnd: T,
    })
  })
  it('waits sixty seconds after reaching current coverage', async () => {
    const f = fixture()
    f.connections[0]!.windowEnd = T
    await f.runtime.tick()
    expect(f.connections[0]!.nextPollAt).toBe(T + 60_000)
    expect(await f.runtime.handle({ method: 'feishu.sync', id })).toEqual({
      ok: false,
      error: 'FEISHU_NOT_DUE',
    })
  })
  it('does not authorize another chat response or out-of-window messages', async () => {
    const f = fixture()
    f.transport.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        code: 0,
        data: {
          items: [
            {
              message_id: 'm1',
              chat_id: 'oc_other',
              create_time: String(T - DAY),
              sender: { sender_type: 'user' },
              body: { content: '{"text":"synthetic"}' },
            },
          ],
          has_more: false,
        },
      },
    })
    expect(await f.runtime.handle(connect)).toEqual({
      ok: false,
      error: 'FEISHU_INVALID_RESPONSE',
    })
    expect(
      f.request.mock.calls.some(([r]) => r.method === 'feishuHost.authorize'),
    ).toBe(false)
  })
  it('preflights pressure before network without changing the page/window', async () => {
    const f = fixture()
    f.pressure()
    await f.runtime.tick()
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.readCredential).not.toHaveBeenCalled()
    expect(f.connections[0]).toMatchObject({
      pageToken: '',
      windowStart: T - 2 * DAY,
      windowEnd: T - DAY,
      completedThrough: null,
      enabled: true,
      errorCode: 'INGESTION_QUEUE_LIMIT',
      nextPollAt: T + 60_000,
    })
  })
  it('preserves a failed sink cursor and retries that page safely', async () => {
    const f = fixture(),
      original = f.request.getMockImplementation()!
    f.transport.mockResolvedValue({
      status: 200,
      headers: {},
      body: { code: 0, data: { items: [], has_more: true, page_token: 'A' } },
    })
    let fail = true
    f.request.mockImplementation((r) =>
      r.method === 'feishuHost.receiveBatch' && fail
        ? Promise.resolve({ ok: false, error: 'INGESTION_QUEUE_LIMIT' })
        : original(r),
    )
    await f.runtime.tick()
    expect(f.connections[0]!.pageToken).toBe('')
    fail = false
    f.setTime(T + 60_000)
    await f.runtime.tick()
    expect(f.connections[0]!.pageToken).toBe('A')
  })
  it('cancels late pages after pause, preserving cursor and ignoring late failure', async () => {
    const f = fixture()
    let release!: (v: Awaited<ReturnType<SourceHttpTransport>>) => void
    f.transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = f.runtime.handle({ method: 'feishu.sync', id })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await f.runtime.handle({ method: 'feishu.setEnabled', id, enabled: false })
    release({
      status: 200,
      headers: {},
      body: { code: 0, data: { items: [], has_more: false } },
    })
    expect(await pending).toEqual({ ok: false, error: 'FEISHU_CANCELLED' })
    expect(
      f.request.mock.calls.some(
        ([r]) =>
          r.method === 'feishuHost.receiveBatch' ||
          r.method === 'feishuHost.recordFailure',
      ),
    ).toBe(false)
  })
  it('persists first-connect rate limits across repeated clicks and restart', async () => {
    const f = fixture()
    f.transport.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '120' },
      body: null,
    })
    expect(await f.runtime.handle(connect)).toEqual({
      ok: false,
      error: 'FEISHU_RATE_LIMITED',
    })
    expect(await createFeishuRuntime(f.deps).handle(connect)).toEqual({
      ok: false,
      error: 'FEISHU_NOT_DUE',
    })
    expect(f.transport).toHaveBeenCalledTimes(1)
    f.setTime(T + 120_000)
    expect(await f.runtime.handle(connect)).toEqual({
      ok: false,
      error: 'FEISHU_RATE_LIMITED',
    })
    expect(f.transport).toHaveBeenCalledTimes(2)
  })
  it('shares credential cooldown across connections without another network call', async () => {
    const f = fixture()
    f.connections.push({ ...f.connections[0]!, id: 'other' })
    f.transport.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '120' },
      body: null,
    })
    await f.runtime.handle({ method: 'feishu.sync', id })
    await f.runtime.handle({ method: 'feishu.sync', id: 'other' })
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.connections[1]!.nextPollAt).toBe(T + 120_000)
    expect(
      f.request.mock.calls.filter(
        ([r]) => r.method === 'feishuHost.recordCooldown',
      ),
    ).toHaveLength(1)
  })
  it('only manually restarts the same window and respects its persisted backoff', async () => {
    const f = fixture()
    f.connections[0]!.pageToken = 'stale'
    expect(
      (await f.runtime.handle({ method: 'feishu.restartWindow', id })).ok,
    ).toBe(true)
    expect(f.connections[0]).toMatchObject({
      pageToken: '',
      windowStart: T - 2 * DAY,
      windowEnd: T - DAY,
      nextPollAt: T + 30_000,
    })
    expect(
      await f.runtime.handle({ method: 'feishu.restartWindow', id }),
    ).toEqual({ ok: false, error: 'FEISHU_NOT_DUE' })
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('snapshots scope before async work and reads fresh credentials per page', async () => {
    const f = fixture()
    let release!: (v: Awaited<ReturnType<SourceHttpTransport>>) => void
    f.transport.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const input = { ...connect }
    const pending = f.runtime.handle(input)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    input.projectId = 'other'
    input.credentialId = 'other'
    input.chatId = 'oc_other'
    release({
      status: 200,
      headers: {},
      body: { code: 0, data: { items: [], has_more: false } },
    })
    await pending
    expect(
      f.request.mock.calls.find(
        ([r]) => r.method === 'feishuHost.authorize',
      )?.[0],
    ).toMatchObject({
      input: { projectId: 'project', chatId: 'oc_synthetic', credentialId },
    })
    f.readCredential.mockResolvedValue('rotated-token')
    await f.runtime.handle({ method: 'feishu.sync', id })
    expect(f.transport.mock.calls.at(-1)![0].bearerToken).toBe('rotated-token')
  })
  it('pauses matching sources until credential deletion finishes; failed deletion stays paused', async () => {
    const f = fixture()
    f.connections.push({
      ...f.connections[0]!,
      id: 'other',
      credentialId: 'other',
    })
    let release!: (r: CoreReply<unknown>) => void
    const remove = vi.fn(
      () =>
        new Promise<CoreReply<unknown>>((resolve) => {
          release = resolve
        }),
    )
    const pending = f.runtime.removeCredential(credentialId, remove)
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce())
    expect(f.connections[0]!.enabled).toBe(false)
    expect(f.connections[1]!.enabled).toBe(true)
    expect(await f.runtime.handle(connect)).toEqual({
      ok: false,
      error: 'FEISHU_BUSY',
    })
    release({ ok: false, error: 'VAULT_WRITE_FAILED' })
    await pending
    expect(f.connections[0]!.enabled).toBe(false)
  })
  it('stops without allowing a late connect to authorize', async () => {
    const f = fixture()
    let release!: (t: string) => void
    f.readCredential.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const pending = f.runtime.handle(connect)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    f.runtime.stop()
    release('synthetic-token')
    expect(await pending).toEqual({ ok: false, error: 'FEISHU_CANCELLED' })
    await f.runtime.tick()
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('treats request latency near the live edge as caught up rather than a one-second polling loop', async () => {
    const f = fixture()
    f.connections[0]!.windowEnd = T
    f.transport.mockImplementation(async () => {
      f.setTime(T + 7000)
      return {
        status: 200,
        headers: {},
        body: { code: 0, data: { items: [], has_more: false } },
      }
    })
    await f.runtime.tick()
    expect(f.connections[0]!.nextPollAt).toBe(T + 67_000)
  })
  it('commits scoped user and explicit deleted events without guessing retraction from text', async () => {
    const f = fixture()
    const message = {
      chat_id: 'oc_synthetic',
      create_time: String(T - DAY - 1000),
      update_time: String(T - DAY - 1000),
      sender: { sender_type: 'user' },
    }
    f.transport.mockResolvedValue({
      status: 200,
      headers: {},
      body: {
        code: 0,
        data: {
          items: [
            {
              ...message,
              message_id: 'm1',
              body: { content: '{"text":"我会提交文档"}' },
            },
            { ...message, message_id: 'm2', deleted: true },
          ],
          has_more: false,
        },
      },
    })
    await f.runtime.tick()
    const commit = f.request.mock.calls
      .map(([r]) => r)
      .find((r) => r.method === 'feishuHost.receiveBatch')!
    expect(commit).toMatchObject({
      expectedGrantVersion: 1,
      expectedPollVersion: 1,
      expectedWindowStart: T - 2 * DAY,
      expectedWindowEnd: T - DAY,
      events: [
        {
          sourceInstanceId: id,
          externalId: 'm1',
          role: 'user',
          text: '我会提交文档',
        },
        {
          sourceInstanceId: id,
          externalId: 'm2',
          role: 'user',
          operation: 'retract',
          text: '',
        },
      ],
    })
  })
  it('retains reader cycle detection across successful pages and never auto-resets a suspicious cursor', async () => {
    const f = fixture()
    for (const token of ['A', 'B', 'A'])
      f.transport.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: {
          code: 0,
          data: { items: [], has_more: true, page_token: token },
        },
      })
    await f.runtime.tick()
    f.setTime(T + 1000)
    await f.runtime.tick()
    f.setTime(T + 2000)
    expect(await f.runtime.handle({ method: 'feishu.sync', id })).toEqual({
      ok: false,
      error: 'FEISHU_PAGE_LOOP',
    })
    expect(f.connections[0]).toMatchObject({
      pageToken: 'B',
      windowStart: T - 2 * DAY,
      windowEnd: T - DAY,
      errorCode: 'FEISHU_PAGE_LOOP',
    })
    expect(
      f.request.mock.calls.some(
        ([r]) => r.method === 'feishuHost.restartWindow',
      ),
    ).toBe(false)
  })
  it('fails closed without network when the durable cooldown cannot be read', async () => {
    const f = fixture(),
      original = f.request.getMockImplementation()!
    f.request.mockImplementation((r) =>
      r.method === 'feishuHost.getCooldown'
        ? Promise.resolve({ ok: false, error: 'CORE_UNAVAILABLE' })
        : original(r),
    )
    await f.runtime.handle(connect)
    await f.runtime.handle({ method: 'feishu.sync', id })
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.readCredential).not.toHaveBeenCalled()
  })
  it.each(['FEISHU_PAGE_LIMIT', 'FEISHU_PAGE_LOOP'] as const)(
    'requires explicit window restart after durable %s without automatic or manual network retry',
    async (code) => {
      const f = fixture()
      f.connections[0]!.errorCode = code
      f.connections[0]!.status = 'error'
      f.connections[0]!.pageToken = 'blocked-page'
      await f.runtime.tick()
      expect(await f.runtime.handle({ method: 'feishu.sync', id })).toEqual({
        ok: false,
        error: code,
      })
      const restarted = createFeishuRuntime(f.deps)
      await restarted.tick()
      await restarted.handle({
        method: 'feishu.setEnabled',
        id,
        enabled: false,
      })
      await restarted.handle({ method: 'feishu.setEnabled', id, enabled: true })
      expect(await restarted.handle({ method: 'feishu.sync', id })).toEqual({
        ok: false,
        error: code,
      })
      expect(f.transport).not.toHaveBeenCalled()
      expect(
        f.request.mock.calls.some(
          ([r]) => r.method === 'feishuHost.recordFailure',
        ),
      ).toBe(false)
      expect(
        (await restarted.handle({ method: 'feishu.restartWindow', id })).ok,
      ).toBe(true)
      f.setTime(T + 30_000)
      await restarted.tick()
      expect(f.transport).toHaveBeenCalledOnce()
    },
  )
})

import { describe, expect, it, vi } from 'vitest'
import {
  createFeishuMessagesFetcher,
  FeishuHistoryAdapter,
} from '../../packages/connectors/src/feishu'
import type { SourceHttpTransport } from '../../packages/connectors/src/http-client'
const signal = () => new AbortController().signal
const item = {
  message_id: 'om_1',
  create_time: '1615380573411',
  update_time: '1615380573412',
  sender: { sender_type: 'app' },
  body: { content: '{"text":"hello"}' },
  deleted: false,
}
const body = () => ({
  code: 0,
  data: { items: [structuredClone(item)], has_more: false },
})
const fetchBody = (value: unknown, status = 200) =>
  createFeishuMessagesFetcher('secret', 'oc_1', async () => ({
    status,
    headers: {},
    body: value,
  }))
const message = {
  messageId: 'm',
  createTime: '1615380573411',
  content: 'text',
  senderType: 'user' as const,
}

describe('Feishu official response validation', () => {
  it('uses only the fixed Feishu host and keeps bearer credentials out of URL', async () => {
    const transport: SourceHttpTransport = vi.fn(async (request) => {
      expect(request.allowedDomain).toBe('open.feishu.cn')
      expect(new URL(request.url).origin).toBe('https://open.feishu.cn')
      expect(request.bearerToken).toBe('secret')
      expect(request.url).not.toContain('secret')
      expect(new URL(request.url).searchParams.get('start_time')).toBe(
        '1615380573',
      )
      return { status: 200, headers: {}, body: body() }
    })
    const fetcher = createFeishuMessagesFetcher('secret', 'oc_1', transport, {
      startTime: new Date(1615380573411),
    })
    const result = await new FeishuHistoryAdapter('s', fetcher).pull(
      '',
      signal(),
    )
    expect(result.events[0]).toMatchObject({
      occurredAt: '2021-03-10T12:49:33.411Z',
      role: 'assistant',
      revision: '1615380573412',
      text: 'hello',
    })
  })
  it.each(['user', 'app', 'anonymous', 'unknown'])(
    'maps official sender type %s without assuming a human',
    async (type) => {
      const b = body()
      b.data.items[0]!.sender.sender_type = type
      const result = await new FeishuHistoryAdapter('s', fetchBody(b)).pull(
        '',
        signal(),
      )
      expect(result.events[0]!.role).toBe(
        type === 'user' ? 'user' : type === 'app' ? 'assistant' : 'tool',
      )
    },
  )
  it.each([
    null,
    {},
    { data: { items: [], has_more: false } },
    { code: 0, data: { items: {}, has_more: false } },
    { code: 0, data: { items: [], has_more: 'false' } },
    { code: 0, data: { items: Array(51).fill(item), has_more: false } },
  ])('rejects malformed or unsuccessful envelopes', async (b) => {
    await expect(fetchBody(b)('', signal())).rejects.toThrow(
      'INVALID_FEISHU_RESPONSE',
    )
  })
  it.each([
    'NaN',
    '-1',
    '1e12',
    '2026-02-30T00:00:00Z',
    '999999999999999',
    '2026-01-01T00:00:00Z',
  ])('rejects invalid official millisecond timestamp %s', async (value) => {
    const b = body()
    b.data.items[0]!.create_time = value
    await expect(fetchBody(b)('', signal())).rejects.toThrow(
      'INVALID_FEISHU_RESPONSE',
    )
  })
  it.each([
    { message_id: '' },
    { deleted: 'true' },
    { sender: { sender_type: 'administrator' } },
    { body: {} },
    { body: { content: 'x'.repeat(65537) } },
    { update_time: 'not-time' },
  ])('rejects malformed messages', async (patch) => {
    await expect(
      fetchBody({
        code: 0,
        data: { items: [{ ...item, ...patch }], has_more: false },
      })('', signal()),
    ).rejects.toThrow('INVALID_FEISHU_RESPONSE')
  })
  it('rejects inherited required response fields', async () => {
    await expect(
      fetchBody(Object.create(body()))('', signal()),
    ).rejects.toThrow('INVALID_FEISHU_RESPONSE')
  })
  it('rejects HTTP errors and redacts transport errors', async () => {
    await expect(fetchBody(body(), 302)('', signal())).rejects.toThrow(
      'FEISHU_HTTP_FAILED',
    )
    const fetcher = createFeishuMessagesFetcher('secret', 'oc_1', async () => {
      throw new Error('secret/path')
    })
    await expect(fetcher('', signal())).rejects.toThrow('FEISHU_HTTP_FAILED')
  })
  it.each([undefined, '', 'same'])(
    'rejects missing or repeated next token %s',
    async (page_token) => {
      await expect(
        fetchBody({ code: 0, data: { items: [], has_more: true, page_token } })(
          'same',
          signal(),
        ),
      ).rejects.toThrow('INVALID_PAGE_CURSOR')
    },
  )
  it('rejects cancellation before and after transport', async () => {
    const controller = new AbortController()
    const transport = vi.fn(async () => {
      controller.abort()
      return { status: 200, headers: {}, body: body() }
    })
    const fetcher = createFeishuMessagesFetcher('secret', 'oc_1', transport)
    await expect(fetcher('', controller.signal)).rejects.toThrow(
      'FEISHU_ABORTED',
    )
    await expect(fetcher('', controller.signal)).rejects.toThrow(
      'FEISHU_ABORTED',
    )
    expect(transport).toHaveBeenCalledTimes(1)
  })
})

describe('Feishu normalized page boundary', () => {
  it('rejects multi-page cycles while permitting retry of the same page', async () => {
    const adapter = new FeishuHistoryAdapter('s', async (cursor) => ({
      items: [],
      hasMore: true,
      pageToken: cursor === 'a' ? 'b' : 'a',
    }))
    await adapter.pull('', signal())
    await adapter.pull('', signal())
    await adapter.pull('a', signal())
    await expect(adapter.pull('b', signal())).rejects.toThrow(
      'INVALID_PAGE_CURSOR',
    )
  })
  it('validates normalized events instead of trusting custom fetchers', async () => {
    const adapter = new FeishuHistoryAdapter('s', async () => ({
      items: [{ ...message, createTime: '2026-02-30T00:00:00Z' }],
      hasMore: false,
    }))
    await expect(adapter.pull('', signal())).rejects.toThrow(
      'INVALID_FEISHU_RESPONSE',
    )
  })
  it('does not return events after cancellation by custom fetchers', async () => {
    const controller = new AbortController()
    const adapter = new FeishuHistoryAdapter('s', async () => {
      controller.abort()
      return { items: [message], hasMore: false }
    })
    await expect(adapter.pull('', controller.signal)).rejects.toThrow(
      'FEISHU_ABORTED',
    )
  })
  it('does not infer retraction from empty content or a literal deletion message', async () => {
    for (const content of ['', '该消息已撤回']) {
      const adapter = new FeishuHistoryAdapter('s', async () => ({
        items: [{ ...message, content, deleted: false }],
        hasMore: false,
      }))
      const result = await adapter.pull('', signal())
      expect(result.events[0]!.operation).toBeUndefined()
    }
  })
  it('keeps equal-update-time upsert and deletion distinct with deterministic replay revisions', async () => {
    const revisions: string[] = []
    for (const deleted of [false, true, true]) {
      const response = body()
      response.data.items[0]!.deleted = deleted
      const adapter = new FeishuHistoryAdapter('s', fetchBody(response))
      const event = (await adapter.pull('', signal())).events[0]!
      revisions.push(event.revision)
      expect(event.operation).toBe(deleted ? 'retract' : undefined)
    }
    expect(revisions).toEqual([
      '1615380573412',
      '1615380573412:retract',
      '1615380573412:retract',
    ])
  })
  it('bounds long opaque deletion revisions without truncating distinct identities', async () => {
    const revisions: string[] = []
    for (const revision of [
      'x'.repeat(128),
      'x'.repeat(127) + 'y',
      'x'.repeat(128),
    ]) {
      const adapter = new FeishuHistoryAdapter('s', async () => ({
        items: [{ ...message, revision, deleted: true }],
        hasMore: false,
      }))
      revisions.push((await adapter.pull('', signal())).events[0]!.revision)
    }
    expect(revisions[0]).toBe(revisions[2])
    expect(revisions[0]).not.toBe(revisions[1])
    expect(
      revisions.every((r) => r.length <= 128 && r.endsWith(':retract')),
    ).toBe(true)
  })
  it('keeps revoked content empty without emitting completion or evidence commands', async () => {
    const adapter = new FeishuHistoryAdapter('s', async () => ({
      items: [{ ...message, deleted: true, revision: 'v2' }],
      hasMore: false,
    }))
    const result = await adapter.pull('', signal())
    expect(result.events[0]).toEqual({
      schemaVersion: 1,
      sourceInstanceId: 's',
      externalId: 'm',
      revision: 'v2:retract',
      occurredAt: '2021-03-10T12:49:33.411Z',
      role: 'user',
      text: '',
      operation: 'retract',
    })
  })
})

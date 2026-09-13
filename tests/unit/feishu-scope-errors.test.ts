import { describe, expect, it } from 'vitest'
import {
  createFeishuMessagesFetcher,
  FeishuHistoryAdapter,
  FeishuRateLimitError,
} from '../../packages/connectors/src/feishu'
import { createSourceHttpTransport } from '../../apps/desktop/src/main/source-http'
const start = 1700000000000
const end = start + 60000
const message = {
  message_id: 'om_test',
  chat_id: 'oc_test',
  create_time: String(start + 1000),
  update_time: String(start + 1000),
  sender: { sender_type: 'user' },
  body: { content: '{"text":"我会完成测试"}' },
}
function reader(
  items: unknown[],
  headers: Record<string, string> = {},
  code = 0,
  status = 200,
) {
  return new FeishuHistoryAdapter(
    'source',
    createFeishuMessagesFetcher(
      'synthetic',
      'oc_test',
      async (request) => {
        const params = new URL(request.url).searchParams
        expect(params.get('sort_type')).toBe('ByCreateTimeAsc')
        expect(params.get('container_id')).toBe('oc_test')
        expect(params.get('start_time')).toBe(String(start / 1000))
        expect(params.get('end_time')).toBe(String(end / 1000))
        return {
          status,
          headers,
          body: {
            code,
            msg: 'untrusted secret',
            data: { items, has_more: false },
          },
        }
      },
      { startTime: new Date(start), endTime: new Date(end), strictScope: true },
    ),
  )
}
const signal = () => new AbortController().signal
describe('Feishu selected-chat scope and fixed errors', () => {
  it('preserves explicit ID type and direct reply without names or root guesses', async () => {
    const result = await reader([
      {
        ...message,
        sender: {
          sender_type: 'user',
          id: 'ou_person',
          id_type: 'open_id',
          sender_name: '同名',
        },
        parent_id: 'om_parent',
        root_id: 'om_root',
        thread_id: 'omt_thread',
      },
    ]).pull('', signal())
    expect(result.events[0]?.metadata).toEqual({
      author: { namespace: 'feishu:open_id', subjectId: 'ou_person' },
      replyToExternalId: 'om_parent',
    })
    expect(result.events[0]?.revision).toBe(`${start + 1000}:context-v1`)
    const legacy = await reader([message]).pull('', signal())
    expect(legacy.events[0]?.metadata).toBeUndefined()
    expect(legacy.events[0]?.revision).toBe(String(start + 1000))
    const changed = await reader([
      {
        ...message,
        sender: { sender_type: 'user', id: 'ou_other', id_type: 'open_id' },
      },
    ]).pull('', signal())
    // Metadata must not choose its own new revision to bypass immutable ingress.
    expect(changed.events[0]?.revision).toBe(result.events[0]?.revision)
  })
  it('keeps incomplete identity unknown and does not use a thread root as direct reply', async () => {
    for (const sender of [
      { sender_type: 'user', id: 'ou_person' },
      { sender_type: 'user', id_type: 'open_id' },
      { sender_type: 'anonymous', id: '', id_type: '' },
    ]) {
      const result = await reader([
        { ...message, sender, root_id: 'om_root', parent_id: '' },
      ]).pull('', signal())
      expect(result.events[0]?.metadata).toBeUndefined()
    }
  })
  it('rejects malformed explicit identity and direct reply before emitting the page', async () => {
    for (const patch of [
      { sender: { sender_type: 'user', id: 'bad id', id_type: 'open_id' } },
      { sender: { sender_type: 'user', id: 123, id_type: 'open_id' } },
      { sender: { sender_type: 'user', id: 'ou_a', id_type: 'x'.repeat(129) } },
      { parent_id: 'bad id' },
      { parent_id: 123 },
    ])
      await expect(
        reader([{ ...message, ...patch }]).pull('', signal()),
      ).rejects.toThrow('INVALID_FEISHU_RESPONSE')
  })
  it('requires explicit selected chat on every item including retractions', async () => {
    for (const patch of [
      { chat_id: undefined },
      { chat_id: 'oc_other' },
      { chat_id: 'oc_other', deleted: true },
    ])
      await expect(
        reader([{ ...message, ...patch }]).pull('', signal()),
      ).rejects.toThrow('INVALID_FEISHU_RESPONSE')
  })
  it('rejects an entire page containing an out-of-window message', async () => {
    for (const time of [start - 1, end + 1])
      await expect(
        reader([message, { ...message, create_time: String(time) }]).pull(
          '',
          signal(),
        ),
      ).rejects.toThrow('INVALID_FEISHU_RESPONSE')
  })
  it('accepts inclusive endpoints and preserves human vs bot role', async () => {
    const result = await reader([
      { ...message, create_time: String(start) },
      {
        ...message,
        message_id: 'om_bot',
        create_time: String(end),
        sender: { sender_type: 'app' },
      },
    ]).pull('', signal())
    expect(result.events.map((e) => e.role)).toEqual(['user', 'assistant'])
  })
  it.each([99991661, 99991671, 99991668, 99991663, 99991677])(
    'maps token code %s without exposing provider text',
    async (code) => {
      await expect(reader([], {}, code).pull('', signal())).rejects.toThrow(
        /^FEISHU_AUTH_FAILED$/,
      )
    },
  )
  it.each([99991672, 99991676, 99991679, 230027])(
    'maps permission code %s',
    async (code) => {
      await expect(reader([], {}, code).pull('', signal())).rejects.toThrow(
        /^FEISHU_PERMISSION_DENIED$/,
      )
    },
  )
  it('does not guess cursor expiry for unknown provider errors', async () => {
    await expect(reader([], {}, 12345).pull('', signal())).rejects.toThrow(
      /^FEISHU_API_FAILED$/,
    )
  })
  it.each([200, 400, 429])(
    'preserves gateway cooldown across fetcher/adapter HTTP %s',
    async (status) => {
      const error = await reader(
        [],
        { 'X-Ogw-Ratelimit-Reset': '120', 'retry-after': '1' },
        99991400,
        status,
      )
        .pull('', signal())
        .catch((e) => e)
      expect(error).toBeInstanceOf(FeishuRateLimitError)
      expect(error.retryAfterMs).toBe(120000)
      expect(error.message).toBe('FEISHU_RATE_LIMITED')
    },
  )
  it('does not shorten long or conflicting provider delays', async () => {
    for (const headers of [
      { 'x-ogw-ratelimit-reset': '691200' },
      { 'x-ogw-ratelimit-reset': '1', 'retry-after': '691200' },
    ] as Record<string, string>[]) {
      const error = await reader([], headers, 99991400)
        .pull('', signal())
        .catch((e) => e)
      expect(error.retryAfterMs).toBe(691200000)
    }
  })
  it('passes only integer error code through real host parsing for old 400 errors', async () => {
    const transport = createSourceHttpTransport(async () => ({
      status: 400,
      headers: {
        'content-type': 'application/json',
        'x-ogw-ratelimit-reset': '52',
      },
      bytes: new TextEncoder().encode(
        JSON.stringify({
          code: 99991400,
          msg: 'private details',
          error: { secret: 'token' },
        }),
      ),
    }))
    const result = await transport({
      url: 'https://open.feishu.cn/open-apis/im/v1/messages',
      allowedDomain: 'open.feishu.cn',
      bearerToken: 'fictionalToken',
      signal: signal(),
    })
    expect(result).toEqual({
      status: 400,
      headers: {
        'content-type': 'application/json',
        'x-ogw-ratelimit-reset': '52',
      },
      body: { code: 99991400 },
    })
    const adapter = new FeishuHistoryAdapter(
      's',
      createFeishuMessagesFetcher('fictionalToken', 'oc_test', transport),
    )
    const error = await adapter.pull('', signal()).catch((e) => e)
    expect(error.retryAfterMs).toBe(52000)
  })
})

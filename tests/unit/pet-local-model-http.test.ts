import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { selectPetTemplate } from '../../packages/model/src/pet-selector'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import {
  createLocalModelTransport,
  type LocalModelRequest,
} from '../../apps/desktop/src/main/pet/local-model-http'
function fixture() {
  const req = new EventEmitter() as EventEmitter & {
    end: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }
  req.end = vi.fn()
  req.destroy = vi.fn()
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number
    headers: Record<string, string>
    destroy: ReturnType<typeof vi.fn>
  }
  res.statusCode = 200
  res.headers = { 'content-type': 'application/json' }
  res.destroy = vi.fn()
  let callback: ((r: IncomingMessage) => void) | undefined
  const send = vi.fn((_: RequestOptions, cb: (r: IncomingMessage) => void) => {
    callback = cb
    return req as unknown as ClientRequest
  }) as ReturnType<typeof vi.fn> & LocalModelRequest
  return {
    send,
    req,
    res,
    start() {
      callback!(res as unknown as IncomingMessage)
    },
    finish(value: string | Uint8Array) {
      res.emit('data', typeof value === 'string' ? Buffer.from(value) : value)
      res.emit('end')
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('fixed loopback model POST', () => {
  it('connects real selector and production transport through only an injected Node request boundary', async () => {
    const f = fixture()
    const call = selectPetTemplate({
      model: 'qwen3:4b',
      candidates: [{ ref: 'ephemeral_1', status: 'waiting' }],
      signal: new AbortController().signal,
      transport: createLocalModelTransport(f.send),
    })
    const sent = JSON.parse(f.req.end.mock.calls[0]![0] as string)
    expect(JSON.parse(sent.messages[1].content)).toEqual({
      candidates: [{ ref: 'ephemeral_1', status: 'waiting' }],
    })
    expect(sent.format.properties.ref.enum).toEqual(['ephemeral_1'])
    f.start()
    f.finish(
      JSON.stringify({
        done: true,
        message: {
          role: 'assistant',
          content: JSON.stringify({ ref: 'ephemeral_1', template: 'open' }),
        },
      }),
    )
    await expect(call).resolves.toEqual({
      ref: 'ephemeral_1',
      template: 'open',
    })
  })
  it('fixes numeric endpoint, no proxy agent, and copies response chunks', async () => {
    const f = fixture(),
      call = createLocalModelTransport(f.send)(
        '{"model":"qwen"}',
        new AbortController().signal,
      )
    expect(f.send.mock.calls[0]![0]).toMatchObject({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      agent: false,
      family: 4,
    })
    expect(f.req.end).toHaveBeenCalledWith('{"model":"qwen"}')
    f.start()
    const b = Buffer.from('{"ok":true}')
    f.res.emit('data', b)
    b.fill(0)
    f.res.emit('end')
    await expect(call).resolves.toBe('{"ok":true}')
  })
  it('cancels before network and during request, releasing busy gate', async () => {
    const f = fixture(),
      t = createLocalModelTransport(f.send),
      c = new AbortController()
    c.abort()
    await expect(t('{}', c.signal)).rejects.toMatchObject({
      code: 'PET_MODEL_CANCELLED',
    })
    expect(f.send).not.toHaveBeenCalled()
    const active = new AbortController(),
      p = t('{}', active.signal)
    const rejected = expect(p).rejects.toMatchObject({
      code: 'PET_MODEL_CANCELLED',
    })
    active.abort()
    await rejected
    expect(f.req.destroy).toHaveBeenCalled()
    const second = t('{}', new AbortController().signal)
    f.start()
    f.finish('{}')
    await expect(second).resolves.toBe('{}')
  })
  it('enforces one in-flight call and 20 second total deadline', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      t = createLocalModelTransport(f.send),
      p = t('{}', new AbortController().signal)
    const rejected = expect(p).rejects.toMatchObject({
      code: 'PET_MODEL_TIMEOUT',
    })
    await expect(t('{}', new AbortController().signal)).rejects.toMatchObject({
      code: 'PET_MODEL_BUSY',
    })
    await vi.advanceTimersByTimeAsync(20_000)
    await rejected
    expect(f.req.destroy).toHaveBeenCalled()
  })
  it.each([301, 302, 307, 401, 404, 429, 500])(
    'does not follow HTTP %i or expose error body',
    async (status) => {
      const f = fixture(),
        p = createLocalModelTransport(f.send)(
          '{}',
          new AbortController().signal,
        )
      f.res.statusCode = status
      f.res.headers.location = 'http://evil'
      f.start()
      f.finish('{"secret":"rawbody"}')
      await expect(p).rejects.toThrow(status === 404 ? 'PET_MODEL_UNAVAILABLE' : status === 429 ? 'PET_MODEL_BUSY' : 'PET_MODEL_OFFLINE')
      expect(f.send).toHaveBeenCalledTimes(1)
    },
  )
  it('rejects request bytes before any network', async () => {
    const f = fixture()
    await expect(
      createLocalModelTransport(f.send)(
        '中'.repeat(6000),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'PET_MODEL_UNAVAILABLE' })
    expect(f.send).not.toHaveBeenCalled()
  })
  it.each(['text/html', 'application/x-ndjson'])(
    'rejects %s',
    async (contentType) => {
      const f = fixture(),
        p = createLocalModelTransport(f.send)(
          '{}',
          new AbortController().signal,
        )
      f.res.headers['content-type'] = contentType
      f.start()
      await expect(p).rejects.toMatchObject({
        code: 'PET_MODEL_INVALID_RESPONSE',
      })
    },
  )
  it.each([
    Buffer.from([0xff]),
    Buffer.from('notJSON'),
    Buffer.alloc(65537, 32),
  ])('rejects bad or excessive response', async (bytes) => {
    const f = fixture(),
      p = createLocalModelTransport(f.send)('{}', new AbortController().signal)
    f.start()
    f.finish(bytes)
    await expect(p).rejects.toMatchObject({
      code: 'PET_MODEL_INVALID_RESPONSE',
    })
  })
  it('rejects declared oversize and early server disconnect', async () => {
    const f = fixture(),
      p = createLocalModelTransport(f.send)('{}', new AbortController().signal)
    f.res.headers['content-length'] = '65537'
    f.start()
    await expect(p).rejects.toMatchObject({
      code: 'PET_MODEL_INVALID_RESPONSE',
    })
    const g = fixture(),
      q = createLocalModelTransport(g.send)('{}', new AbortController().signal)
    g.start()
    g.res.emit('aborted')
    await expect(q).rejects.toMatchObject({ code: 'PET_MODEL_OFFLINE' })
  })
  it('scrubs socket errors', async () => {
    const f = fixture(),
      p = createLocalModelTransport(f.send)('{}', new AbortController().signal)
    f.req.emit('error', Error('private request details'))
    await expect(p).rejects.toThrow('PET_MODEL_OFFLINE')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourcePoller } from '../../packages/connectors/src/polling'
import type {
  FeishuMessagePage,
  FeishuPageFetcher,
} from '../../packages/connectors/src/feishu'
const page = (token?: string): FeishuMessagePage => ({
  items: [],
  hasMore: token !== undefined,
  ...(token ? { pageToken: token } : {}),
})
afterEach(() => vi.useRealTimers())
describe('fenced source poller', () => {
  it('never starts sink when pull resolves after abort', async () => {
    let resolve!: (p: FeishuMessagePage) => void
    const pull = vi.fn<FeishuPageFetcher>().mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const sink = vi.fn().mockResolvedValue(0)
    const controller = new AbortController()
    const poller = new SourcePoller(pull, sink, 0)
    const pending = poller.run('confirmed', controller.signal)
    controller.abort()
    resolve(page('uncommitted'))
    expect(await pending).toBe('confirmed')
    expect(sink).not.toHaveBeenCalled()
    expect(poller.getDiagnostics().committedPages).toBe(0)
  })
  it('retains cursor if an already-started sink commits despite cancellation', async () => {
    let commit!: (n: number) => void
    const sink = vi.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          commit = resolve
        }),
    )
    const controller = new AbortController()
    const poller = new SourcePoller(async () => page('committed'), sink, 0)
    const pending = poller.run('before', controller.signal)
    await Promise.resolve()
    expect(sink).toHaveBeenCalledWith(
      expect.anything(),
      'committed',
      controller.signal,
    )
    controller.abort()
    commit(0)
    expect(await pending).toBe('committed')
    expect(poller.getDiagnostics().committedPages).toBe(1)
  })
  it('does not retry or re-fetch after ambiguous sink failure', async () => {
    const pull = vi.fn<FeishuPageFetcher>().mockResolvedValue(page('next'))
    const sink = vi.fn().mockRejectedValue(new Error('AMBIGUOUS_COMMIT'))
    const poller = new SourcePoller(pull, sink, 0)
    await expect(
      poller.run('before', new AbortController().signal),
    ).rejects.toThrow('AMBIGUOUS_COMMIT')
    expect(pull).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledTimes(1)
    expect(poller.getDiagnostics().committedPages).toBe(0)
  })
  it('never loops or commits a repeated cursor', async () => {
    const pull = vi
      .fn<FeishuPageFetcher>()
      .mockResolvedValueOnce(page('b'))
      .mockResolvedValueOnce(page('a'))
    const sink = vi.fn().mockResolvedValue(0)
    vi.useFakeTimers()
    const pending = new SourcePoller(pull, sink, 0).run(
      'a',
      new AbortController().signal,
    )
    const rejected = expect(pending).rejects.toThrow('POLL_CURSOR_LOOP')
    await vi.runAllTimersAsync()
    await rejected
    expect(sink).toHaveBeenCalledTimes(1)
  })
  it('rejects missing continuation before committing', async () => {
    const sink = vi.fn()
    await expect(
      new SourcePoller(async () => ({ items: [], hasMore: true }), sink, 0).run(
        '',
        new AbortController().signal,
      ),
    ).rejects.toThrow('INVALID_PAGE_CURSOR')
    expect(sink).not.toHaveBeenCalled()
  })
  it('returns the last committed cursor at the per-run page budget', async () => {
    const pull = vi.fn<FeishuPageFetcher>().mockResolvedValue(page('more'))
    const sink = vi.fn().mockResolvedValue(0)
    const poller = new SourcePoller(pull, sink, 1000, 60000, 3, 1)
    expect(await poller.run('', new AbortController().signal)).toBe('more')
    expect(pull).toHaveBeenCalledTimes(1)
  })
  it('uses bounded exponential retry times and stops at failure budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const pull = vi
      .fn<FeishuPageFetcher>()
      .mockRejectedValue(new Error('offline'))
    const poller = new SourcePoller(pull, async () => 0, 100, 150, 3)
    const pending = poller.run('safe', new AbortController().signal)
    const rejected = expect(pending).rejects.toThrow('offline')
    await Promise.resolve()
    expect(poller.getDiagnostics().nextRetryAt).toBe(100)
    await vi.advanceTimersByTimeAsync(100)
    expect(poller.getDiagnostics().nextRetryAt).toBe(250)
    await vi.advanceTimersByTimeAsync(150)
    await rejected
    expect(pull).toHaveBeenCalledTimes(3)
    expect(poller.getDiagnostics()).toMatchObject({
      failedPulls: 3,
      consecutiveFailures: 3,
      nextRetryAt: null,
    })
  })
  it('removes abort listeners after normal delay and cancellation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener'),
      remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pull = vi
      .fn<FeishuPageFetcher>()
      .mockResolvedValueOnce(page('next'))
      .mockResolvedValueOnce(page())
    const poller = new SourcePoller(pull, async () => 0, 10)
    const pending = poller.run('', controller.signal)
    await vi.runAllTimersAsync()
    await pending
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    const retry = new SourcePoller(
      async () => {
        throw new Error('retry')
      },
      async () => 0,
      1000,
    )
    const waiting = retry.run('saved', controller.signal)
    await Promise.resolve()
    controller.abort()
    expect(await waiting).toBe('saved')
    expect(add).toHaveBeenCalledTimes(2)
    expect(remove).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects concurrent runs and allows later runs after settling', async () => {
    let resolve!: (p: FeishuMessagePage) => void
    const pull: FeishuPageFetcher = () =>
      new Promise((r) => {
        resolve = r
      })
    const poller = new SourcePoller(pull, async () => 0, 0)
    const signal = new AbortController().signal
    const first = poller.run('', signal)
    await expect(poller.run('', signal)).rejects.toThrow('POLL_ALREADY_RUNNING')
    resolve(page())
    await first
    const second = poller.run('', signal)
    resolve(page())
    await second
  })
  it('exposes only copied counters and timestamps', async () => {
    const poller = new SourcePoller(
      async () => ({
        items: [
          { messageId: 'secret', createTime: 'secret', content: 'PRIVATE' },
        ],
        hasMore: false,
      }),
      async () => 1,
      0,
      60000,
      3,
      100,
      () => 123,
    )
    await poller.run('PRIVATE_CURSOR', new AbortController().signal)
    const data = poller.getDiagnostics()
    expect(data).toMatchObject({
      committedPages: 1,
      insertedRecords: 1,
      lastSuccessAt: 123,
    })
    data.committedPages = 999
    expect(poller.getDiagnostics().committedPages).toBe(1)
    expect(JSON.stringify(data)).not.toContain('PRIVATE')
  })
  it.each([-1, 1.5, NaN, Infinity])('rejects invalid delay %s', (delay) => {
    expect(
      () =>
        new SourcePoller(
          async () => page(),
          async () => 0,
          delay,
        ),
    ).toThrow('INVALID_POLL_DELAY')
  })
  it('validates failure and page ceilings and delay ordering', () => {
    expect(
      () =>
        new SourcePoller(
          async () => page(),
          async () => 0,
          1,
          0,
        ),
    ).toThrow('INVALID_POLL_DELAY')
    expect(
      () =>
        new SourcePoller(
          async () => page(),
          async () => 0,
          0,
          60000,
          21,
        ),
    ).toThrow('INVALID_POLL_FAILURE_LIMIT')
    expect(
      () =>
        new SourcePoller(
          async () => page(),
          async () => 0,
          0,
          60000,
          3,
          1001,
        ),
    ).toThrow('INVALID_POLL_PAGE_LIMIT')
  })
  it('honors server retry-after beyond the ordinary max backoff', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const limited = Object.assign(new Error('limited'), { retryAfterMs: 5000 })
    const pull = vi
      .fn<FeishuPageFetcher>()
      .mockRejectedValueOnce(limited)
      .mockResolvedValueOnce(page())
    const poller = new SourcePoller(pull, async () => 0, 100, 200)
    const pending = poller.run('saved', new AbortController().signal)
    await Promise.resolve()
    expect(poller.getDiagnostics().nextRetryAt).toBe(6000)
    await vi.advanceTimersByTimeAsync(4999)
    expect(pull).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBe('')
    expect(pull).toHaveBeenCalledTimes(2)
  })
  it.each([-1, Infinity, NaN, 86400001])(
    'rejects invalid server retry delay %s without another request',
    async (retryAfterMs) => {
      const pull = vi
        .fn<FeishuPageFetcher>()
        .mockRejectedValue(
          Object.assign(new Error('limited'), { retryAfterMs }),
        )
      await expect(
        new SourcePoller(pull, async () => 0, 0).run(
          '',
          new AbortController().signal,
        ),
      ).rejects.toThrow('INVALID_POLL_RETRY_DELAY')
      expect(pull).toHaveBeenCalledTimes(1)
    },
  )
})

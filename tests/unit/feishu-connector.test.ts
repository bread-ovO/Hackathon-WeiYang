import { describe, expect, it, vi } from 'vitest'
import {
  decodeFeishuContent,
  FeishuHistoryAdapter,
  SourcePoller,
} from '../../packages/connectors/src/index'

describe('FeishuHistoryAdapter', () => {
  it('maps a page and returns the server cursor', async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: [
        {
          messageId: 'om_1',
          createTime: '2026-09-13T01:00:00Z',
          senderType: 'user',
          content: '请提交 PR',
        },
      ],
      pageToken: 'next',
      hasMore: true,
    })
    const result = await new FeishuHistoryAdapter('chat:oc_1', fetchPage).pull(
      '',
      new AbortController().signal,
    )
    expect(result.nextCursor).toBe('next')
    expect(result.events[0]).toMatchObject({
      externalId: 'om_1',
      role: 'user',
      text: '请提交 PR',
    })
    expect(fetchPage).toHaveBeenCalledWith('', expect.any(AbortSignal))
  })

  it('preserves deletion as a new revision and ends pagination', async () => {
    const fetchPage = vi.fn().mockResolvedValue({
      items: [
        {
          messageId: 'om_2',
          createTime: '2026-09-13T01:00:00Z',
          senderType: 'bot',
          content: 'old',
          deleted: true,
          revision: 'v2',
        },
      ],
      hasMore: false,
    })
    const result = await new FeishuHistoryAdapter('chat:oc_1', fetchPage).pull(
      'old-cursor',
      new AbortController().signal,
    )
    expect(result.nextCursor).toBe('')
    expect(result.events[0]).toMatchObject({
      revision: 'v2',
      role: 'assistant',
      text: '',
    })
  })

  it('decodes JSON text and leaves plain text unchanged', () => {
    expect(decodeFeishuContent('{"text":"hello"}')).toBe('hello')
    expect(decodeFeishuContent('plain')).toBe('plain')
    expect(decodeFeishuContent(undefined)).toBe('')
  })

  it('stops after the final page and invokes the sink for each page', async () => {
    const calls: string[] = []
    const poller = new SourcePoller(
      async (cursor) => {
        calls.push(cursor)
        return cursor
          ? { items: [], hasMore: false }
          : { items: [], pageToken: 'p2', hasMore: true }
      },
      async (_page, cursor) => {
        calls.push(`sink:${cursor}`)
        return 0
      },
      0,
    )
    await expect(poller.run('', new AbortController().signal)).resolves.toBe('')
    expect(calls).toEqual(['', 'sink:p2', 'p2', 'sink:'])
  })

  it('rejects a page marked as having more data without a cursor', async () => {
    const poller = new SourcePoller(
      async () => ({ items: [], hasMore: true }),
      async () => 0,
      0,
      0,
      1,
    )
    await expect(poller.run('', new AbortController().signal)).rejects.toThrow(
      'INVALID_PAGE_CURSOR',
    )
  })

  it('returns the current cursor when aborted', async () => {
    const controller = new AbortController()
    const poller = new SourcePoller(
      async () => {
        controller.abort()
        return { items: [], pageToken: 'later', hasMore: true }
      },
      async () => 0,
      0,
    )
    await expect(poller.run('start', controller.signal)).resolves.toBe('start')
  })

  it('stops retrying after the configured failure limit', async () => {
    let calls = 0
    const poller = new SourcePoller(
      async () => {
        calls += 1
        throw new Error('offline')
      },
      async () => 0,
      0,
      0,
      2,
    )
    await expect(poller.run('', new AbortController().signal)).rejects.toThrow(
      'offline',
    )
    expect(calls).toBe(2)
  })
})

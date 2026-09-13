import { describe, expect, it, vi } from 'vitest'
import {
  decodeFeishuContent,
  FeishuHistoryAdapter,
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

  it('versions metadata observations stably, including maximum length revisions and retractions', async () => {
    const message = {
      messageId: 'om_context',
      createTime: '2026-09-13T01:00:00Z',
      senderType: 'user' as const,
      senderId: 'ou_person',
      senderIdType: 'open_id',
      parentId: 'om_parent',
      content: '截止时间改到 2026-09-20T10:00:00+08:00',
      revision: 'r'.repeat(128),
    }
    const pull = (item: typeof message & { deleted?: boolean }) =>
      new FeishuHistoryAdapter('chat:oc_1', async () => ({
        items: [item],
        hasMore: false,
      })).pull('', new AbortController().signal)
    const original = (await pull(message)).events[0]!
    const repeat = (await pull(message)).events[0]!
    const changed = (await pull({ ...message, senderId: 'ou_other' }))
      .events[0]!
    const deleted = (await pull({ ...message, deleted: true })).events[0]!
    expect(original).toEqual(repeat)
    expect(original.revision.length).toBeLessThanOrEqual(128)
    expect(original.revision).toMatch(/^sha256:[a-f0-9]{64}:context-v1$/)
    expect(changed.revision).toBe(original.revision)
    expect(deleted.revision).toBe(`${original.revision}:retract`)
    expect(deleted.metadata).toEqual(original.metadata)
    expect(deleted.text).toBe('')
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
      revision: 'v2:retract',
      operation: 'retract',
      role: 'assistant',
      text: '',
    })
  })

  it('decodes JSON text and leaves plain text unchanged', () => {
    expect(decodeFeishuContent('{"text":"hello"}')).toBe('hello')
    expect(decodeFeishuContent('plain')).toBe('plain')
    expect(decodeFeishuContent(undefined)).toBe('')
  })
})

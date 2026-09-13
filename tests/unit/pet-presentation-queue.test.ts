import { describe, it, expect } from 'vitest'
import { createPresentationQueue } from '../../apps/desktop/src/main/pet/presentation-queue'
describe('bounded model-bound presentations', () => {
  it('serializes, rejects stale ack and clears across epochs', () => {
    const q = createPresentationQueue(),
      allowed = new Set(['motion:0'])
    q.bind('model/window1')
    expect(
      q.enqueue(
        'model/window1',
        { kind: 'bubble', text: '你好 <b>原样文字</b>' },
        allowed,
      ),
    ).toBe(true)
    const first = q.current()!
    q.enqueue(
      'model/window1',
      { kind: 'action', actionId: 'motion:0' },
      allowed,
    )
    expect(q.current()).toEqual(first)
    expect(q.ack('other', first.id)).toBe(false)
    expect(q.ack('model/window1', first.id)).toBe(true)
    expect(q.current()?.kind).toBe('action')
    expect(q.ack('model/window1', first.id)).toBe(false)
    q.bind('model/window2')
    expect(q.current()).toBeNull()
  })
  it('bounds queue and text, disallows unknown actions and cannot mutate snapshots', () => {
    const q = createPresentationQueue(),
      allowed = new Set(['a'])
    q.bind('m')
    for (const text of ['', ' ', 'a\u0000b', 'a'.repeat(241)])
      expect(q.enqueue('m', { kind: 'bubble', text }, allowed)).toBe(false)
    expect(q.enqueue('m', { kind: 'action', actionId: 'evil' }, allowed)).toBe(
      false,
    )
    for (let i = 0; i < 8; i++)
      expect(q.enqueue('m', { kind: 'bubble', text: String(i) }, allowed)).toBe(
        true,
      )
    expect(q.enqueue('m', { kind: 'bubble', text: 'overflow' }, allowed)).toBe(
      false,
    )
    q.current()!.text = 'changed'
    expect(q.current()?.text).toBe('0')
    q.dismissBubble()
    expect(q.current()?.text).toBe('1')
    q.clear()
    expect(q.current()).toBeNull()
    expect(q.enqueue('m', { kind: 'bubble', text: 'late' }, allowed)).toBe(
      false,
    )
  })
})

it('preserves multiline and tab text while rejecting other control characters', () => {
  const q = createPresentationQueue()
  q.bind('m')
  const text = '第一行\n第二行\r\n\t缩进'
  expect(q.enqueue('m', { kind: 'bubble', text }, new Set())).toBe(true)
  expect(q.current()?.text).toBe(text)
  for (const char of [
    '\u0001',
    '\u000b',
    '\u000c',
    '\u001f',
    '\u007f',
    '\u0085',
  ])
    expect(
      q.enqueue('m', { kind: 'bubble', text: 'a' + char + 'b' }, new Set()),
    ).toBe(false)
})

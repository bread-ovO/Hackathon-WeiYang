import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPetPresentationPlayer } from '../../apps/desktop/src/renderer/src/pet-bubble'
describe('serialized pet presentations', () => {
  let action: { id: string | null; kind: 'idle' | 'motion' | 'expression' },
    close: (() => void) | undefined
  const show = vi.fn(),
    hide = vi.fn(),
    ack = vi.fn(),
    play = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    action = { id: null, kind: 'idle' }
    close = undefined
    show.mockReset()
    hide.mockReset()
    ack.mockReset().mockResolvedValue(undefined)
    play.mockReset().mockImplementation(async (id: string) => {
      action = { id, kind: 'motion' }
      return { status: 'playing' }
    })
  })
  afterEach(() => vi.useRealTimers())
  const create = () =>
    createPetPresentationPlayer({
      show: (text, fn) => {
        show(text)
        close = fn
      },
      hide,
      ack,
      play,
      currentAction: () => action,
    })
  it('displays hostile markup as an unchanged text payload once and dismisses at 12s', async () => {
    const player = create(),
      item = {
        id: '1',
        kind: 'bubble' as const,
        text: '<img src=x onerror=alert(1)>',
      }
    player.sync(item)
    player.sync(item)
    expect(show).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith(item.text)
    await vi.advanceTimersByTimeAsync(11999)
    expect(ack).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ack).toHaveBeenCalledWith({ id: '1', status: 'done' })
    player.sync(item)
    expect(show).toHaveBeenCalledTimes(1)
  })
  it('manual close acknowledges without waiting for the timeout', async () => {
    const player = create()
    player.sync({ id: '1', kind: 'bubble', text: 'hello' })
    close!()
    await Promise.resolve()
    expect(ack).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(12000)
    expect(ack).toHaveBeenCalledTimes(1)
  })
  it('waits until one-shot motion returns to idle before acknowledging', async () => {
    const player = create(),
      item = { id: '1', kind: 'action' as const, actionId: 'motion:1:0' }
    player.sync(item)
    await Promise.resolve()
    player.sync(item)
    player.tick()
    expect(play).toHaveBeenCalledTimes(1)
    expect(ack).not.toHaveBeenCalled()
    action = { id: null, kind: 'idle' }
    player.tick()
    await Promise.resolve()
    expect(ack).toHaveBeenCalledWith({ id: '1', status: 'done' })
  })
  it('does not acknowledge before asynchronous action startup resolves', async () => {
    let finish!: (value: { status: 'playing' }) => void
    play.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const player = create()
    player.sync({ id: '1', kind: 'action', actionId: 'motion:1:0' })
    player.tick()
    expect(ack).not.toHaveBeenCalled()
    action = { id: 'motion:1:0', kind: 'motion' }
    finish({ status: 'playing' })
    await Promise.resolve()
    player.tick()
    expect(ack).not.toHaveBeenCalled()
  })
  it('a bubble with a motion waits for both the text dismissal and idle', async () => {
    const player = create()
    player.sync({
      id: '1',
      kind: 'bubble',
      text: 'hello',
      actionId: 'motion:1:0',
    })
    await Promise.resolve()
    close!()
    expect(ack).not.toHaveBeenCalled()
    action = { id: null, kind: 'idle' }
    player.tick()
    expect(ack).toHaveBeenCalledWith({ id: '1', status: 'done' })
  })
  it.each(['unavailable', 'reject'])(
    'missing action leaves bubble text functional: %s',
    async (mode) => {
      if (mode === 'reject') play.mockRejectedValue(new Error('missing'))
      else play.mockResolvedValue({ status: 'unavailable' })
      const player = create()
      player.sync({
        id: '1',
        kind: 'bubble',
        text: 'still visible',
        actionId: 'missing',
      })
      await vi.advanceTimersByTimeAsync(12000)
      expect(show).toHaveBeenCalledWith('still visible')
      expect(ack).toHaveBeenCalledWith({ id: '1', status: 'done' })
    },
  )
  it('unavailable action-only item unblocks the host queue', async () => {
    play.mockResolvedValue({ status: 'unavailable' })
    const player = create()
    player.sync({ id: '1', kind: 'action', actionId: 'missing' })
    await Promise.resolve()
    expect(ack).toHaveBeenCalledWith({ id: '1', status: 'unavailable' })
  })
  it('clear cancels timers and ignores late action results', async () => {
    let finish!: (value: { status: 'unavailable' }) => void
    play.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    const player = create()
    player.sync({ id: '1', kind: 'bubble', text: 'old', actionId: 'missing' })
    player.clear()
    finish({ status: 'unavailable' })
    await vi.advanceTimersByTimeAsync(15000)
    expect(ack).not.toHaveBeenCalled()
  })
  it('retries failed acknowledgement without replaying the animation', async () => {
    ack.mockRejectedValueOnce(new Error('temporary'))
    play.mockResolvedValue({ status: 'unavailable' })
    const player = create(),
      item = { id: '1', kind: 'action' as const, actionId: 'missing' }
    player.sync(item)
    await vi.advanceTimersByTimeAsync(0)
    player.sync(item)
    await Promise.resolve()
    expect(play).toHaveBeenCalledTimes(1)
    expect(ack).toHaveBeenCalledTimes(2)
  })
})

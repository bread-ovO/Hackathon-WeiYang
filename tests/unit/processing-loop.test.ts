import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessingLoop } from '../../apps/desktop/src/core/processing-loop'

afterEach(() => vi.useRealTimers())
describe('local processing loop', () => {
  it('yields after four jobs and does not duplicate startup timers', () => {
    vi.useFakeTimers()
    const runOne = vi.fn(() => true)
    const loop = createProcessingLoop({
      isEnabled: () => true,
      runOne,
      onError: vi.fn(),
    })
    loop.start()
    loop.start()
    vi.advanceTimersByTime(0)
    expect(runOne).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(49)
    expect(runOne).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(1)
    expect(runOne).toHaveBeenCalledTimes(8)
    loop.dispose()
    vi.advanceTimersByTime(10000)
    expect(runOne).toHaveBeenCalledTimes(8)
  })
  it('pauses without claiming and resume wakes the same loop', () => {
    vi.useFakeTimers()
    let enabled = false
    const runOne = vi.fn(() => {
      enabled = false
      return true
    })
    const loop = createProcessingLoop({
      isEnabled: () => enabled,
      runOne,
      onError: vi.fn(),
    })
    loop.start()
    vi.advanceTimersByTime(5000)
    expect(runOne).not.toHaveBeenCalled()
    enabled = true
    loop.wake()
    vi.advanceTimersByTime(0)
    expect(runOne).toHaveBeenCalledTimes(1)
    loop.dispose()
    enabled = true
    loop.wake()
    loop.start()
    vi.advanceTimersByTime(10000)
    expect(runOne).toHaveBeenCalledTimes(1)
  })
  it('backs off repeated failures even when diagnostics also fail', () => {
    vi.useFakeTimers()
    const runOne = vi.fn(() => {
      throw Error('synthetic')
    })
    const loop = createProcessingLoop({
      isEnabled: () => true,
      runOne,
      onError: () => {
        throw Error('synthetic')
      },
    })
    loop.start()
    vi.advanceTimersByTime(0)
    expect(runOne).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(runOne).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1999)
    expect(runOne).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(runOne).toHaveBeenCalledTimes(3)
    loop.dispose()
  })
})

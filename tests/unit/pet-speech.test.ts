import { describe, expect, it } from 'vitest'
import {
  createSpeechScheduler,
  inQuietHours,
  type SpeechState,
} from '../../apps/desktop/src/main/pet/speech-scheduler'
import {
  bubbleSize,
  createBubbleController,
  placeBubble,
  type BubblePlatform,
  type BubbleWindowLike,
} from '../../apps/desktop/src/main/pet/bubble-window'

const minute = 60_000
const presets = ['A', 'B', 'C', 'D', 'E']
const makeScheduler = (startAt: number, persisted: Partial<SpeechState> | null = null) => {
  let now = startAt
  const saved: SpeechState[] = []
  const scheduler = createSpeechScheduler({
    now: () => now,
    presets,
    loadState: () => persisted,
    saveState: (state) => saved.push(state),
  })
  return {
    scheduler,
    saved,
    advance: (minutes: number) => {
      now += minutes * minute
    },
    setNow: (value: number) => {
      now = value
    },
    now: () => now,
  }
}
// 2026-09-13T12:00 local-independent anchor in UTC; quiet tests use explicit
// local times via Date construction below.
const anchor = Date.UTC(2026, 8, 13, 4, 0) // 12:00 in UTC+8

describe('speech scheduler (PET10)', () => {
  it('speaks within the configured random window', () => {
    const h = makeScheduler(anchor)
    h.scheduler.configure({ minMinutes: 45, maxMinutes: 90, quietStart: '00:00', quietEnd: '00:00' })
    // Before the window opens nothing happens even after many ticks.
    h.advance(44)
    expect(h.scheduler.tick()).toBeNull()
    // Somewhere in [45, 90] the tick must fire.
    let spoke: string | null = null
    for (let i = 0; i < 46 && !spoke; i++) {
      h.advance(1)
      spoke = h.scheduler.tick()
    }
    expect(spoke).toBeTruthy()
    expect(h.scheduler.state().todayCount).toBe(1)
  })
  it('never exceeds the daily cap and does not catch up afterwards', () => {
    const h = makeScheduler(anchor)
    h.scheduler.configure({ minMinutes: 1, maxMinutes: 1, dailyCap: 2, quietStart: '00:00', quietEnd: '00:00' })
    for (let i = 0; i < 5; i++) {
      h.advance(2)
      h.scheduler.tick()
    }
    expect(h.scheduler.state().todayCount).toBe(2)
    // A long suspension (system sleep) does not replay missed windows.
    h.advance(600)
    expect(h.scheduler.tick()).toBeNull()
    expect(h.scheduler.state().todayCount).toBe(2)
  })
  it('respects quiet hours including ranges crossing midnight', () => {
    // Local-time construction keeps the assertion timezone independent.
    const local = (hour: number) => new Date(2026, 8, 13, hour, 0).getTime()
    expect(inQuietHours(local(15), '22:00', '09:00')).toBe(false)
    expect(inQuietHours(local(23), '22:00', '09:00')).toBe(true)
    expect(inQuietHours(local(1), '22:00', '09:00')).toBe(true)
    expect(inQuietHours(local(9), '22:00', '09:00')).toBe(false)
  })
  it('stays silent when disabled, paused or locked', () => {
    const h = makeScheduler(anchor)
    h.scheduler.configure({ minMinutes: 1, maxMinutes: 1, quietStart: '00:00', quietEnd: '00:00' })
    h.scheduler.configure({ enabled: false })
    h.advance(2)
    expect(h.scheduler.tick()).toBeNull()
    h.scheduler.configure({ enabled: true, paused: true })
    h.advance(2)
    expect(h.scheduler.tick()).toBeNull()
    h.scheduler.configure({ paused: false })
    h.scheduler.setSuppressed('locked')
    h.advance(2)
    expect(h.scheduler.tick()).toBeNull()
    h.scheduler.setSuppressed('none')
    h.advance(2)
    expect(h.scheduler.tick()).toBeTruthy()
  })
  it('does not repeat recent presets and persists cadence state', () => {
    const h = makeScheduler(anchor)
    h.scheduler.configure({ minMinutes: 1, maxMinutes: 1, quietStart: '00:00', quietEnd: '00:00' })
    const spoken: string[] = []
    for (let i = 0; i < 4; i++) {
      h.advance(2)
      const line = h.scheduler.tick()
      if (line) spoken.push(line)
    }
    expect(new Set(spoken).size).toBe(spoken.length)
    expect(h.saved.length).toBeGreaterThan(0)
    // Restart restores cadence instead of resetting the day.
    const last = h.saved[h.saved.length - 1]!
    const restarted = makeScheduler(h.now(), last)
    expect(restarted.scheduler.state().todayCount).toBe(last.todayCount)
  })
  it('rejects malformed configuration', () => {
    const h = makeScheduler(anchor)
    expect(() => h.scheduler.configure({ quietStart: '99:00' })).toThrow()
    expect(() => h.scheduler.configure({ minMinutes: 0 })).toThrow()
    expect(() => h.scheduler.configure({ dailyCap: 99 })).toThrow()
  })
})

describe('bubble controller (PET09)', () => {
  const fakePlatform = (
    pet: { x: number; y: number; width: number; height: number } = { x: 400, y: 400, width: 320, height: 420 },
  ): {
    platform: BubblePlatform
    windows: {
      shown: number
      hidden: number
      destroyed: number
      sent: { channel: string; payload: unknown }[]
      bounds: { x: number; y: number; width: number; height: number }
      visible: boolean
    }[]
    pet: { x: number; y: number; width: number; height: number }
  } => {
    const windows: {
      shown: number
      hidden: number
      destroyed: number
      sent: { channel: string; payload: unknown }[]
      bounds: { x: number; y: number; width: number; height: number }
      visible: boolean
    }[] = []
    const area = { x: 0, y: 0, width: 1920, height: 1040 }
    const platform: BubblePlatform = {
      createWindow: () => {
        const win = {
          shown: 0,
          hidden: 0,
          destroyed: 0,
          sent: [] as { channel: string; payload: unknown }[],
          bounds: { x: 0, y: 0, width: bubbleSize.width, height: bubbleSize.height } as { x: number; y: number; width: number; height: number },
          visible: false,
        }
        windows.push(win)
        const like: BubbleWindowLike = {
          isVisible: () => win.visible,
          isDestroyed: () => win.destroyed > 0,
          show: () => {
            win.shown++
            win.visible = true
          },
          hide: () => {
            win.hidden++
            win.visible = false
          },
          destroy: () => {
            win.destroyed++
            win.visible = false
          },
          setBounds: (bounds) => {
            win.bounds = bounds
          },
          getBounds: () => win.bounds,
          webContents: {
            send: (channel, payload) => win.sent.push({ channel, payload }),
          },
        }
        return like
      },
      usableArea: () => area,
      petBounds: () => pet,
    }
    return { platform, windows, pet }
  }
  it('shows one message at a time and queues the rest', () => {
    const { platform, windows } = fakePlatform()
    const bubble = createBubbleController(platform)
    bubble.speak('第一句')
    bubble.speak('第二句')
    bubble.speak('第三句')
    expect(windows).toHaveLength(1)
    expect(bubble.displaying()).toBe('第一句')
    expect(bubble.pending()).toBe(2)
    expect(windows[0]!.sent).toHaveLength(1)
    bubble.dismiss()
    expect(bubble.displaying()).toBe('第二句')
    expect(windows[0]!.sent).toHaveLength(2)
    expect(windows[0]!.shown).toBe(2)
  })
  it('drops duplicates of the visible message and blank text', () => {
    const { platform } = fakePlatform()
    const bubble = createBubbleController(platform)
    bubble.speak('相同的话')
    bubble.speak('相同的话')
    bubble.speak('   ')
    expect(bubble.pending()).toBe(0)
  })
  it('places the bubble above the pet and inside the screen', () => {
    expect(
      placeBubble({ x: 400, y: 400, width: 320, height: 420 }, { x: 0, y: 0, width: 1920, height: 1040 }).y,
    ).toBe(400 - bubbleSize.height - 12)
    // Pet near the left/top edge: bubble clamps into the visible area.
    const nearEdge = placeBubble({ x: 0, y: 0, width: 320, height: 420 }, { x: 0, y: 0, width: 1920, height: 1040 })
    expect(nearEdge.x).toBeGreaterThanOrEqual(0)
    expect(nearEdge.y).toBeGreaterThanOrEqual(0)
  })
  it('dispose clears queue and window exactly once', () => {
    const { platform, windows } = fakePlatform()
    const bubble = createBubbleController(platform)
    bubble.speak('hi')
    bubble.dispose()
    bubble.dispose()
    expect(windows[0]!.destroyed).toBe(1)
    expect(bubble.pending()).toBe(0)
    expect(bubble.displaying()).toBeNull()
  })
})

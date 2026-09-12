import { describe, expect, it } from 'vitest'
import {
  clampIntoArea,
  createPetWindowController,
  petScaleRange,
  type PetWindowLike,
  type PetWindowPlatform,
} from '../../apps/desktop/src/main/pet/pet-window'

interface RecordingWindow extends PetWindowLike {
  shown: number
  hidden: number
  destroyed: number
  ignored: { ignore: boolean; forward: boolean }[]
  boundsHistory: { x: number; y: number; width: number; height: number }[]
  closeListeners: ((event: { preventDefault(): void }) => void)[]
  crashListeners: (() => void)[]
  visible: boolean
  destroyedFlag: boolean
  savedBounds: { x: number; y: number; width: number; height: number }
}
const makeWindow = (): RecordingWindow => {
  const win = {
    shown: 0,
    hidden: 0,
    destroyed: 0,
    ignored: [] as { ignore: boolean; forward: boolean }[],
    boundsHistory: [] as { x: number; y: number; width: number; height: number }[],
    closeListeners: [] as ((event: { preventDefault(): void }) => void)[],
    crashListeners: [] as (() => void)[],
    visible: false,
    destroyedFlag: false,
    savedBounds: { x: 0, y: 0, width: 320, height: 420 },
  } as unknown as RecordingWindow
  win.isVisible = () => win.visible && !win.destroyedFlag
  win.isDestroyed = () => win.destroyedFlag
  win.show = () => { win.shown++; win.visible = true }
  win.hide = () => { win.hidden++; win.visible = false }
  win.destroy = () => { win.destroyed++; win.destroyedFlag = true; win.visible = false }
  win.focus = () => {}
  win.setIgnoreMouseEvents = (ignore, options) => win.ignored.push({ ignore, ...options! })
  win.setAlwaysOnTop = () => {}
  win.getBounds = () => win.savedBounds
  win.setBounds = (bounds) => {
    win.savedBounds = bounds
    win.boundsHistory.push(bounds)
  }
  win.on = (event: string, listener: never) => {
    if (event === 'close') win.closeListeners.push(listener)
    if (event === 'render-process-gone') win.crashListeners.push(listener)
  }
  return win
}
const makePlatform = (
  area = { x: 0, y: 0, width: 1920, height: 1040 },
): {
  platform: PetWindowPlatform
  windows: RecordingWindow[]
  displayListeners: (() => void)[]
  area: { x: number; y: number; width: number; height: number }
} => {
  const windows: RecordingWindow[] = []
  const displayListeners: (() => void)[] = []
  return {
    windows,
    displayListeners,
    area,
    platform: {
      createWindow: () => {
        const win = makeWindow()
        windows.push(win)
        return win
      },
      usableArea: () => area,
      onDisplayChanged: (listener) => displayListeners.push(listener),
    },
  }
}

describe('pet window controller', () => {
  it('refuses to show without a current model and creates nothing', async () => {
    const { platform, windows } = makePlatform()
    const controller = createPetWindowController({
      platform,
      hasCurrentModel: async () => false,
    })
    await expect(controller.show()).resolves.toEqual({ ok: false, reason: 'no-model' })
    expect(windows).toHaveLength(0)
    expect(controller.displaying()).toBe(false)
  })
  it('shows, hides and reports display intent', async () => {
    const { platform, windows } = makePlatform()
    const controller = createPetWindowController({
      platform,
      hasCurrentModel: async () => true,
    })
    await controller.show()
    expect(windows).toHaveLength(1)
    expect(windows[0]!.shown).toBe(1)
    expect(controller.displaying()).toBe(true)
    controller.hide()
    expect(windows[0]!.hidden).toBe(1)
    expect(controller.displaying()).toBe(false)
    // Showing again reuses the same window.
    await controller.show()
    expect(windows).toHaveLength(1)
    expect(windows[0]!.shown).toBe(2)
  })
  it('window close is intercepted into a hide, never a real close', async () => {
    const { platform, windows } = makePlatform()
    const controller = createPetWindowController({
      platform,
      hasCurrentModel: async () => true,
    })
    await controller.show()
    let prevented = 0
    windows[0]!.closeListeners[0]!({ preventDefault: () => prevented++ })
    expect(prevented).toBe(1)
    expect(windows[0]!.destroyed).toBe(0)
    expect(controller.displaying()).toBe(false)
  })
  it('renderer crash destroys the window and clears display; show recreates', async () => {
    const { platform, windows } = makePlatform()
    const controller = createPetWindowController({
      platform,
      hasCurrentModel: async () => true,
    })
    await controller.show()
    windows[0]!.crashListeners[0]!()
    expect(windows[0]!.destroyed).toBe(1)
    expect(controller.displaying()).toBe(false)
    await controller.show()
    expect(windows).toHaveLength(2)
    expect(windows[1]!.shown).toBe(1)
  })
  it('scales within bounds and persists placement', async () => {
    const { platform } = makePlatform()
    const saved: unknown[] = []
    const controller = createPetWindowController({
      platform,
      hasCurrentModel: async () => true,
      saveState: state => saved.push(state),
      loadState: () => ({ x: 100, y: 200, scale: 1.5 }),
    })
    expect(controller.scale()).toBe(1.5)
    await controller.show()
    controller.setScale(9)
    expect(controller.scale()).toBe(petScaleRange.max)
    controller.setScale(0.01)
    expect(controller.scale()).toBe(petScaleRange.min)
    expect(saved.length).toBeGreaterThanOrEqual(2)
  })
  it('clamps placement back when a display disappears', async () => {
    const harness = makePlatform({ x: 0, y: 0, width: 1920, height: 1040 })
    const controller = createPetWindowController({
      platform: harness.platform,
      hasCurrentModel: async () => true,
      loadState: () => ({ x: 1500, y: 900, scale: 1 }),
    })
    await controller.show()
    // Monitor removed; the remaining display is much smaller.
    harness.area.width = 1280
    harness.area.height = 720
    harness.displayListeners[0]!()
    const bounds = harness.windows[0]!.savedBounds
    expect(bounds.x).toBeLessThanOrEqual(1280 - bounds.width)
    expect(bounds.y).toBeLessThanOrEqual(720 - bounds.height)
  })
  it('passthrough toggles forwarded ignore state', async () => {
    const { platform, windows } = makePlatform()
    const controller = createPetWindowController({
      platform,
      hasCurrentModel: async () => true,
    })
    await controller.show()
    controller.setMousePassthrough(true)
    expect(windows[0]!.ignored.at(-1)).toEqual({ ignore: true, forward: true })
    controller.setMousePassthrough(false)
    expect(windows[0]!.ignored.at(-1)).toEqual({ ignore: false, forward: true })
  })
  it('dispose destroys exactly once', async () => {
    const { platform, windows } = makePlatform()
    const controller = createPetWindowController({
      platform,
      hasCurrentModel: async () => true,
    })
    await controller.show()
    controller.dispose()
    controller.dispose()
    expect(windows[0]!.destroyed).toBe(1)
  })
})

describe('clampIntoArea', () => {
  const area = { x: 0, y: 0, width: 1000, height: 800 }
  it('keeps already-visible bounds', () => {
    expect(clampIntoArea({ x: 100, y: 100, width: 320, height: 420 }, area)).toEqual({
      x: 100,
      y: 100,
    })
  })
  it('pulls strayed bounds back inside', () => {
    expect(clampIntoArea({ x: 5000, y: -200, width: 320, height: 420 }, area)).toEqual({
      x: 680,
      y: 0,
    })
  })
})

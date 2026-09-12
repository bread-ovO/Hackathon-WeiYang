import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/** Window surface the controller needs; mirrors the BrowserWindow subset. */
export interface PetWindowLike {
  isVisible(): boolean
  isDestroyed(): boolean
  show(): void
  hide(): void
  destroy(): void
  focus(): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void
  setAlwaysOnTop(flag: boolean): void
  getBounds(): { x: number; y: number; width: number; height: number }
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void
  on(event: 'render-process-gone', listener: () => void): void
  on(event: 'closed', listener: () => void): void
}
export interface PetWindowPlatform {
  createWindow(): PetWindowLike
  /** Visible display bounds used to keep the pet reachable. */
  usableArea(): { x: number; y: number; width: number; height: number }
  onDisplayChanged(listener: () => void): void
}
export interface PetWindowPersistState {
  x: number
  y: number
  scale: number
}
export interface PetWindowDeps {
  platform: PetWindowPlatform
  /** Model presence gates showing; a pet without a model stays hidden. */
  hasCurrentModel(): Promise<boolean>
  stateFile?: string
  loadState?: () => PetWindowPersistState | null
  saveState?: (state: PetWindowPersistState) => void
}

export const petSize = { width: 320, height: 420 } as const
export const petScaleRange = { min: 0.5, max: 2 } as const
const defaultState = (): PetWindowPersistState => {
  const area = { x: 0, y: 0, width: 1280, height: 720 }
  return {
    x: Math.round(area.width - petSize.width - 48),
    y: Math.round(area.height - petSize.height - 48),
    scale: 1,
  }
}
const clampScale = (scale: number) =>
  Math.min(petScaleRange.max, Math.max(petScaleRange.min, scale))

/** Keeps the pet fully inside the usable area after display changes. */
export function clampIntoArea(
  bounds: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const maxX = area.x + area.width - bounds.width
  const maxY = area.y + area.height - bounds.height
  return {
    x: Math.round(Math.min(Math.max(bounds.x, area.x), Math.max(area.x, maxX))),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), Math.max(area.y, maxY))),
  }
}

/** PET05/07/08 window lifecycle: show/hide, persisted placement, bounded
 * scaling, display-loss recovery, click-through toggling and crash isolation.
 * All Electron surface is injected, so the state machine is unit-testable. */
export function createPetWindowController(deps: PetWindowDeps) {
  const loadState = deps.loadState ?? (() => {
    try {
      if (deps.stateFile && existsSync(deps.stateFile))
        return JSON.parse(readFileSync(deps.stateFile, 'utf8')) as PetWindowPersistState
    } catch { /* corrupt state falls back to defaults */ }
    return null
  })
  const saveState =
    deps.saveState ??
    ((state: PetWindowPersistState) => {
      try {
        if (deps.stateFile) writeFileSync(deps.stateFile, JSON.stringify(state))
      } catch { /* persistence is best-effort; placement is not critical data */ }
    })
  let state: PetWindowPersistState = loadState() ?? defaultState()
  state.scale = clampScale(state.scale)
  let window: PetWindowLike | null = null
  let display = false
  let ignoreMouse = false

  const applyBounds = () => {
    if (!window) return
    const width = Math.round(petSize.width * state.scale)
    const height = Math.round(petSize.height * state.scale)
    const { x, y } = clampIntoArea({ ...state, width, height }, deps.platform.usableArea())
    state = { ...state, x, y }
    window.setBounds({ x, y, width, height })
  }
  const createIfAbsent = () => {
    if (window) return
    const created = deps.platform.createWindow()
    created.on('close', event => {
      // The pet never closes on its own; hide instead (main window owns exit).
      event.preventDefault()
      hide()
    })
    created.on('render-process-gone', () => {
      // Crash containment: drop the window, keep the app and display intent off.
      if (!created.isDestroyed()) created.destroy()
      if (window === created) window = null
      display = false
    })
    created.on('closed', () => {
      if (window === created) window = null
    })
    window = created
    applyBounds()
    created.setAlwaysOnTop(true)
  }
  deps.platform.onDisplayChanged(() => {
    // A removed monitor must not strand the pet; pull it back on next layout.
    if (window && !window.isDestroyed()) applyBounds()
  })

  async function show(): Promise<{ ok: true } | { ok: false; reason: 'no-model' }> {
    if (!(await deps.hasCurrentModel())) {
      display = false
      return { ok: false, reason: 'no-model' }
    }
    display = true
    createIfAbsent()
    applyBounds()
    window!.show()
    window!.setIgnoreMouseEvents(ignoreMouse, { forward: true })
    return { ok: true }
  }
  function hide() {
    display = false
    if (window && !window.isDestroyed()) window.hide()
  }
  return {
    show,
    hide,
    displaying(): boolean {
      return display
    },
    /** PET07: bounded zoom, placement preserved. */
    setScale(next: number): void {
      state = { ...state, scale: clampScale(next) }
      saveState(state)
      if (window && !window.isDestroyed() && display) applyBounds()
    },
    scale(): number {
      return state.scale
    },
    /** PET08: transparent-area pass-through toggle from the renderer. */
    setMousePassthrough(enabled: boolean): void {
      ignoreMouse = enabled
      if (window && !window.isDestroyed())
        window.setIgnoreMouseEvents(enabled, { forward: true })
    },
    /** Never leave a window behind app teardown. */
    dispose(): void {
      display = false
      if (window && !window.isDestroyed()) window.destroy()
      window = null
    },
  }
}

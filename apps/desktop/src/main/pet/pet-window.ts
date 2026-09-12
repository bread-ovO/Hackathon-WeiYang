import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/** Window surface the controller needs; mirrors the BrowserWindow subset. */
export interface PetWindowLike {
  isVisible(): boolean
  isDestroyed(): boolean
  showInactive(): void
  hide(): void
  destroy(): void
  focus(): void
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void
  setAlwaysOnTop(flag: boolean): void
  getBounds(): { x: number; y: number; width: number; height: number }
  setBounds(bounds: {
    x: number
    y: number
    width: number
    height: number
  }): void
  on(
    event: 'close',
    listener: (event: { preventDefault(): void }) => void,
  ): void
  on(event: 'render-process-gone', listener: () => void): void
  on(event: 'closed', listener: () => void): void
}
export interface PetWindowPlatform {
  createWindow(): PetWindowLike
  /** Visible display bounds used to keep the pet reachable. */
  usableArea(bounds?: {
    x: number
    y: number
    width: number
    height: number
  }): { x: number; y: number; width: number; height: number }
  onDisplayChanged(listener: () => void): () => void
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

/** Window lifecycle primitives; full dragging and hit-testing UI are separate.
 * Placement, display-loss recovery and crash isolation are host controlled.
 * All Electron surface is injected, so the state machine is unit-testable. */
export function createPetWindowController(deps: PetWindowDeps) {
  const loadState =
    deps.loadState ??
    (() => {
      try {
        if (deps.stateFile && existsSync(deps.stateFile))
          return JSON.parse(
            readFileSync(deps.stateFile, 'utf8'),
          ) as PetWindowPersistState
      } catch {
        /* corrupt state falls back to defaults */
      }
      return null
    })
  const saveState =
    deps.saveState ??
    ((state: PetWindowPersistState) => {
      try {
        if (deps.stateFile) writeFileSync(deps.stateFile, JSON.stringify(state))
      } catch {
        /* persistence is best-effort; placement is not critical data */
      }
    })
  let state = defaultState()
  try {
    const loaded = loadState()
    if (
      loaded &&
      [loaded.x, loaded.y, loaded.scale].every(Number.isFinite) &&
      loaded.scale > 0
    )
      state = { x: loaded.x, y: loaded.y, scale: clampScale(loaded.scale) }
  } catch {
    /* Invalid saved placement falls back to defaults. */
  }
  let window: PetWindowLike | null = null
  let display = false
  let disposed = false
  let generation = 0
  let ignoreMouse = false
  let alwaysOnTop = false
  const persist = () => {
    try {
      saveState({ ...state })
    } catch {
      /* Best effort. */
    }
  }
  const applyBounds = () => {
    if (!window || window.isDestroyed()) return
    const desired = {
      x: state.x,
      y: state.y,
      width: Math.round(petSize.width * state.scale),
      height: Math.round(petSize.height * state.scale),
    }
    const area = deps.platform.usableArea(desired)
    if (
      ![area.x, area.y, area.width, area.height].every(Number.isFinite) ||
      area.width < 1 ||
      area.height < 1
    )
      throw new Error('PET_INVALID_DISPLAY')
    const bounds = {
      ...desired,
      width: Math.min(desired.width, Math.floor(area.width)),
      height: Math.min(desired.height, Math.floor(area.height)),
    }
    const { x, y } = clampIntoArea(bounds, area)
    state = { ...state, x, y }
    window.setBounds({ ...bounds, x, y })
    persist()
  }
  function rendererGone() {
    generation++
    display = false
    const old = window
    window = null
    if (old && !old.isDestroyed()) old.destroy()
  }
  const createIfAbsent = () => {
    if (window && !window.isDestroyed()) return window
    const created = deps.platform.createWindow()
    window = created
    created.on('close', (event) => {
      if (disposed || window !== created) return
      event.preventDefault()
      hide()
    })
    created.on('render-process-gone', () => {
      if (window === created) rendererGone()
    })
    created.on('closed', () => {
      if (window === created) {
        window = null
        display = false
        generation++
      }
    })
    created.setAlwaysOnTop(alwaysOnTop)
    return created
  }
  const unsubscribe = deps.platform.onDisplayChanged(() => {
    if (disposed) return
    if (window && !window.isDestroyed()) {
      const bounds = window.getBounds()
      if ([bounds.x, bounds.y].every(Number.isFinite))
        state = { ...state, x: bounds.x, y: bounds.y }
      applyBounds()
    }
  })
  async function show(): Promise<
    | { ok: true }
    | {
        ok: false
        reason: 'no-model' | 'cancelled' | 'disposed' | 'unavailable'
      }
  > {
    if (disposed) return { ok: false, reason: 'disposed' }
    const requested = ++generation
    try {
      const hasModel = await deps.hasCurrentModel()
      if (disposed || requested !== generation)
        return { ok: false, reason: 'cancelled' }
      if (!hasModel) {
        hide()
        return { ok: false, reason: 'no-model' }
      }
      const created = createIfAbsent()
      applyBounds()
      created.setIgnoreMouseEvents(ignoreMouse, { forward: true })
      created.showInactive()
      display = true
      return { ok: true }
    } catch {
      if (requested !== generation || disposed)
        return { ok: false, reason: 'cancelled' }
      rendererGone()
      return { ok: false, reason: 'unavailable' }
    }
  }
  function hide() {
    generation++
    display = false
    if (window && !window.isDestroyed()) window.hide()
  }
  return {
    show,
    hide,
    rendererGone,
    displaying(): boolean {
      return display && !!window && !window.isDestroyed() && window.isVisible()
    },
    setScale(next: number): void {
      if (disposed || !Number.isFinite(next)) return
      state = { ...state, scale: clampScale(next) }
      applyBounds()
      persist()
    },
    scale(): number {
      return state.scale
    },
    rememberPosition(): void {
      if (disposed || !window || window.isDestroyed()) return
      const bounds = window.getBounds()
      if (![bounds.x, bounds.y].every(Number.isFinite)) return
      state = { ...state, x: bounds.x, y: bounds.y }
      applyBounds()
    },
    setAlwaysOnTop(enabled: boolean): void {
      if (disposed) return
      alwaysOnTop = enabled === true
      if (window && !window.isDestroyed()) window.setAlwaysOnTop(alwaysOnTop)
    },
    setMousePassthrough(enabled: boolean): void {
      if (disposed) return
      ignoreMouse = enabled === true
      if (window && !window.isDestroyed())
        window.setIgnoreMouseEvents(ignoreMouse, { forward: true })
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      unsubscribe()
      rendererGone()
    },
  }
}

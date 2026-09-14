import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  renameSync,
  mkdirSync,
  rmSync,
} from 'node:fs'

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
  cursorPosition?(): { x: number; y: number }
  onDisplayChanged(listener: () => void): () => void
}
export interface PetWindowPersistState {
  x: number
  y: number
  scale: number
  alwaysOnTop?: boolean
  clickThrough?: boolean
  performanceMode?: 'balanced' | 'smooth'
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
        if (deps.stateFile && existsSync(deps.stateFile)) {
          const stat = lstatSync(deps.stateFile)
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
            return null
          return JSON.parse(
            readFileSync(deps.stateFile, 'utf8'),
          ) as PetWindowPersistState
        }
      } catch {
        /* corrupt state falls back to defaults */
      }
      return null
    })
  const saveState =
    deps.saveState ??
    ((state: PetWindowPersistState) => {
      try {
        if (deps.stateFile) {
          mkdirSync(dirname(deps.stateFile), { recursive: true, mode: 0o700 })
          const temporary = deps.stateFile + '.' + randomUUID() + '.tmp'
          try {
            writeFileSync(temporary, JSON.stringify(state), {
              flag: 'wx',
              mode: 0o600,
            })
            renameSync(temporary, deps.stateFile)
          } finally {
            rmSync(temporary, { force: true })
          }
        }
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
      loaded.scale > 0 &&
      Math.abs(loaded.x) <= 10000000 &&
      Math.abs(loaded.y) <= 10000000
    )
      state = {
        x: loaded.x,
        y: loaded.y,
        scale: clampScale(loaded.scale),
        alwaysOnTop: loaded.alwaysOnTop === true,
        clickThrough: loaded.clickThrough !== false,
        performanceMode: loaded.performanceMode === 'smooth' ? 'smooth' : 'balanced',
      }
  } catch {
    /* Invalid saved placement falls back to defaults. */
  }
  let window: PetWindowLike | null = null
  let display = false
  let disposed = false
  let generation = 0
  let alwaysOnTop = state.alwaysOnTop === true
  let performanceMode = state.performanceMode ?? 'balanced'
  let clickThrough = state.clickThrough !== false
  let interactive = false
  let drag: { x: number; y: number; cursorX: number; cursorY: number } | null =
    null
  const applyMouse = () => {
    if (window && !window.isDestroyed())
      window.setIgnoreMouseEvents(clickThrough && !interactive && !drag, {
        forward: true,
      })
  }
  const persist = () => {
    try {
      saveState({ ...state, alwaysOnTop, clickThrough, performanceMode })
    } catch {
      /* Best effort. */
    }
  }
  let applyingBounds = false
  const applyBounds = (save = true) => {
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
    applyingBounds = true
    try {
      window.setBounds({ ...bounds, x, y })
    } finally {
      applyingBounds = false
    }
    if (save) persist()
  }
  function rendererGone() {
    generation++
    display = false
    drag = null
    interactive = false
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
      applyMouse()
      created.showInactive()
      // macOS can reposition an initially hidden window as it is shown.
      // Restore the controlled placement after the native show transition.
      applyBounds()
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
    drag = null
    interactive = false
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
      // Native resize/move callbacks can expose intermediate geometry during setBounds.
      // Initial placement must also win over platform-created default bounds.
      if (
        disposed ||
        applyingBounds ||
        !display ||
        !window ||
        window.isDestroyed()
      )
        return
      const bounds = window.getBounds()
      if (![bounds.x, bounds.y].every(Number.isFinite)) return
      if (state.x === bounds.x && state.y === bounds.y) return
      state = { ...state, x: bounds.x, y: bounds.y }
      applyBounds()
    },
    setAlwaysOnTop(enabled: boolean): void {
      if (disposed) return
      alwaysOnTop = enabled === true
      if (window && !window.isDestroyed()) window.setAlwaysOnTop(alwaysOnTop)
      persist()
    },
    setMousePassthrough(enabled: boolean): void {
      if (disposed) return
      clickThrough = enabled === true
      applyMouse()
      persist()
    },
    setPerformanceMode(value: 'balanced' | 'smooth') {
      if (disposed || !['balanced', 'smooth'].includes(value)) return
      performanceMode = value
      persist()
    },
    preferences() {
      return { scale: state.scale, alwaysOnTop, clickThrough, performanceMode }
    },
    hitTest(value: boolean) {
      if (disposed) return
      interactive = value
      applyMouse()
    },
    drag(phase: 'start' | 'move' | 'end') {
      if (disposed || !window || window.isDestroyed() || !display) return
      if (phase === 'end') {
        drag = null
        applyMouse()
        persist()
        return
      }
      const point = deps.platform.cursorPosition?.()
      if (!point || ![point.x, point.y].every(Number.isFinite)) return
      if (phase === 'start') {
        if (!interactive) return
        drag = { x: state.x, y: state.y, cursorX: point.x, cursorY: point.y }
        applyMouse()
      } else if (drag) {
        state = {
          ...state,
          x: drag.x + point.x - drag.cursorX,
          y: drag.y + point.y - drag.cursorY,
        }
        applyBounds(false)
      }
    },
    resetPosition() {
      if (disposed) return
      const area = deps.platform.usableArea()
      state = {
        ...state,
        x: area.x + area.width - petSize.width * state.scale - 24,
        y: area.y + area.height - petSize.height * state.scale - 24,
      }
      applyBounds()
      persist()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      unsubscribe()
      rendererGone()
    },
  }
}

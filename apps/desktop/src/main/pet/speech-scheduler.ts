import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export interface SpeechConfig {
  enabled: boolean
  paused: boolean
  /** Local quiet window, e.g. 22:00–09:00. */
  quietStart: string
  quietEnd: string
  /** Random speech interval bounds in minutes. */
  minMinutes: number
  maxMinutes: number
  dailyCap: number
}
export interface SpeechState {
  config: SpeechConfig
  lastSpokeAt: number | null
  todayCount: number
  today: string
  /** Epoch ms of the next allowed speech attempt. */
  nextAt: number
  suppressed: 'none' | 'locked'
}
export const defaultSpeechConfig = (): SpeechConfig => ({
  enabled: true,
  paused: false,
  quietStart: '22:00',
  quietEnd: '09:00',
  minMinutes: 45,
  maxMinutes: 90,
  dailyCap: 6,
})
export interface SpeechDeps {
  /** Injectable clock keeps the scheduler deterministic in tests. */
  now(): number
  presets: string[]
  stateFile?: string
  loadState?(): Partial<SpeechState> | null
  saveState?(state: SpeechState): void
}

const minute = 60_000
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10)
const parseClock = (value: string) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
/** Local-time quiet window; supports ranges crossing midnight (22:00–09:00). */
export function inQuietHours(
  at: number,
  quietStart: string,
  quietEnd: string,
): boolean {
  const start = parseClock(quietStart)
  const end = parseClock(quietEnd)
  if (start === null || end === null || start === end) return false
  const local = new Date(at)
  const minutes = local.getHours() * 60 + local.getMinutes()
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

const randomBetween = (min: number, max: number) =>
  min + Math.random() * (max - min)

/** PET10 scheduler: low-frequency proactive speech with cooldown, daily cap,
 * quiet hours, lock suppression and no catch-up after suspension. */
export function createSpeechScheduler(deps: SpeechDeps) {
  const loadState = deps.loadState ?? (() => {
    try {
      if (deps.stateFile && existsSync(deps.stateFile))
        return JSON.parse(readFileSync(deps.stateFile, 'utf8')) as Partial<SpeechState>
    } catch { /* corrupt state restarts the cadence */ }
    return null
  })
  const saveState =
    deps.saveState ?? ((state: SpeechState) => {
      try {
        if (deps.stateFile) writeFileSync(deps.stateFile, JSON.stringify(state))
      } catch { /* cadence state is best-effort, never critical */ }
    })
  const persisted = loadState()
  let recentPresetIndexes: number[] = []
  const pickPreset = (): string => {
    // Dedup recent lines so the companion does not parrot itself.
    const pool = deps.presets
      .map((line, index) => ({ line, index }))
      .filter((item) => !recentPresetIndexes.includes(item.index))
    const chosen = (pool.length ? pool : deps.presets.map((line, index) => ({ line, index })))[
      Math.floor(Math.random() * (pool.length || deps.presets.length))
    ]!
    recentPresetIndexes = [...recentPresetIndexes, chosen.index].slice(-3)
    return chosen.line
  }
  const state: SpeechState = {
    config: defaultSpeechConfig(),
    lastSpokeAt: null,
    todayCount: 0,
    today: dayKey(deps.now()),
    nextAt: deps.now() + randomBetween(45, 90) * minute,
    suppressed: 'none',
    ...(persisted?.config ? { config: { ...defaultSpeechConfig(), ...persisted.config } } : {}),
    ...(persisted?.lastSpokeAt !== undefined ? { lastSpokeAt: persisted.lastSpokeAt } : {}),
    ...(persisted?.todayCount !== undefined ? { todayCount: persisted.todayCount } : {}),
    ...(persisted?.nextAt !== undefined ? { nextAt: persisted.nextAt } : {}),
  }
  const persist = () => saveState(structuredClone(state))

  const reschedule = (from: number) => {
    const { minMinutes, maxMinutes } = state.config
    state.nextAt = from + randomBetween(
      Math.min(minMinutes, maxMinutes),
      Math.max(minMinutes, maxMinutes),
    ) * minute
  }
  const rollDayIfNeeded = (at: number) => {
    const today = dayKey(at)
    if (state.today !== today) {
      state.today = today
      state.todayCount = 0
    }
  }
  return {
    state: () => structuredClone(state),
    configure(patch: Partial<SpeechConfig>): SpeechState {
      const minutes = (v: number | undefined) =>
        v === undefined || (v >= 1 && v <= 240)
      if (
        !minutes(patch.minMinutes) ||
        !minutes(patch.maxMinutes) ||
        (patch.dailyCap !== undefined &&
          !(patch.dailyCap >= 1 && patch.dailyCap <= 24)) ||
        (patch.quietStart !== undefined && parseClock(patch.quietStart) === null) ||
        (patch.quietEnd !== undefined && parseClock(patch.quietEnd) === null)
      )
        throw new Error('INVALID_SPEECH_CONFIG')
      state.config = { ...state.config, ...patch }
      // Interval changes re-anchor the next attempt from now.
      if (patch.minMinutes !== undefined || patch.maxMinutes !== undefined)
        reschedule(deps.now())
      persist()
      return this.state()
    },
    setSuppressed(reason: 'none' | 'locked'): void {
      state.suppressed = reason
    },
    /** Advances the schedule; returns a line to speak when allowed. */
    tick(): string | null {
      const at = deps.now()
      rollDayIfNeeded(at)
      if (at < state.nextAt) return null
      const { enabled, paused, quietStart, quietEnd, dailyCap } = state.config
      if (
        !enabled ||
        paused ||
        state.suppressed !== 'none' ||
        state.todayCount >= dailyCap ||
        inQuietHours(at, quietStart, quietEnd)
      ) {
        // Missed windows are never replayed; just look forward.
        reschedule(at)
        persist()
        return null
      }
      const line = pickPreset()
      state.lastSpokeAt = at
      state.todayCount += 1
      reschedule(at)
      persist()
      return line
    },
  }
}

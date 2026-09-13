/** Local, opt-in companion speech. A decision reserves quota before the host emits. */
export interface PetSpeechSettings {
  enabled: boolean
  frequency: 'low' | 'normal'
  quietStart: number
  quietEnd: number
  pausedUntil: number | null
}
export interface PetSpeechState {
  version: 1
  preferences: PetSpeechSettings
  nextAt: number | null
  day: string
  count: number
  recent: string[]
  lastNow: number
  suppressed: boolean
}
export interface PetSpeechClock {
  now(): number
  random(): number
  localTime?(timestamp: number): { day: string; minute: number }
}
export interface PetSpeechEnvironment {
  locked: boolean
  asleep: boolean
  fullscreen: boolean
  visible: boolean
  busy: boolean
  /** Set on process start and explicit OS resume, even after a short interruption. */
  resumed?: boolean
}
export type PetSpeechReason = 'disabled' | 'paused' | 'quiet' | 'suppressed' | 'cooldown' | 'daily-limit' | 'reserved'
export interface PetSpeechDecision {
  state: PetSpeechState
  speech: { id: string; text: string } | null
  reason: PetSpeechReason
}
export const PET_SPEECH_DEFAULTS: Readonly<PetSpeechSettings> = Object.freeze({ enabled: false, frequency: 'normal', quietStart: 1320, quietEnd: 540, pausedUntil: null })
export const PET_SPEECH_DAILY_LIMIT = 6
export const PET_SPEECH_RECENT_LIMIT = 4
export const PET_SPEECH_RESUME_GAP_MS = 5 * 60_000
export const PET_SPEECH_LINES: readonly Readonly<{ id: string; text: string }>[] = Object.freeze([
  { id: 'stretch', text: '如果方便，可以伸个懒腰，活动一下肩膀。' },
  { id: 'water', text: '手边有水的话，记得喝一口。' },
  { id: 'eyes', text: '要不要看一会儿远处，让眼睛歇一歇？' },
  { id: 'pace', text: '按自己的节奏来就好。' },
  { id: 'company', text: '我在这里，安静陪你一会儿。' },
  { id: 'breathe', text: '可以慢慢呼吸一下，再继续手边的事。' },
  { id: 'desk', text: '有空时，给桌面留一点舒服的空间吧。' },
  { id: 'break', text: '如果正好有空，给自己留个小小的休息。' },
  { id: 'small-step', text: '想开始时，可以先选一个容易着手的小步骤。' },
  { id: 'check-in', text: '需要整理思路时，可以回工作区看看。' },
].map(line => Object.freeze(line)))
const MAX_TIME = 8_640_000_000_000_000 - 180 * 60_000
const fail = (): never => { throw new Error('PET_SPEECH_INVALID_STATE') }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const timestamp = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TIME
const minute = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 1440
function validDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
function settings(value: unknown): PetSpeechSettings {
  if (!record(value) || !exact(value, ['enabled', 'frequency', 'quietStart', 'quietEnd', 'pausedUntil']) || typeof value.enabled !== 'boolean' || !['low', 'normal'].includes(value.frequency as string) || !minute(value.quietStart) || !minute(value.quietEnd) || (value.pausedUntil !== null && !timestamp(value.pausedUntil))) return fail()
  return { enabled: value.enabled, frequency: value.frequency as 'low' | 'normal', quietStart: value.quietStart, quietEnd: value.quietEnd, pausedUntil: value.pausedUntil as number | null }
}
export function parsePetSpeechState(value: unknown): PetSpeechState {
  if (!record(value) || !exact(value, ['version', 'preferences', 'nextAt', 'day', 'count', 'recent', 'lastNow', 'suppressed']) || value.version !== 1 || (value.nextAt !== null && !timestamp(value.nextAt)) || !validDay(value.day) || !Number.isInteger(value.count) || (value.count as number) < 0 || (value.count as number) > PET_SPEECH_DAILY_LIMIT || !Array.isArray(value.recent) || value.recent.length > PET_SPEECH_RECENT_LIMIT || new Set(value.recent).size !== value.recent.length || value.recent.some(id => !PET_SPEECH_LINES.some(line => line.id === id)) || !timestamp(value.lastNow) || typeof value.suppressed !== 'boolean') return fail()
  return { version: 1, preferences: settings(value.preferences), nextAt: value.nextAt as number | null, day: value.day, count: value.count as number, recent: [...value.recent] as string[], lastNow: value.lastNow, suppressed: value.suppressed }
}
function time(clock: PetSpeechClock) {
  const now = clock.now()
  if (!timestamp(now)) return fail()
  const date = new Date(now)
  const local = clock.localTime ? clock.localTime(now) : {
    day: `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`,
    minute: date.getHours() * 60 + date.getMinutes(),
  }
  if (!validDay(local.day) || !minute(local.minute)) return fail()
  return { now, ...local }
}
function random(clock: PetSpeechClock) {
  const value = clock.random()
  if (!Number.isFinite(value) || value < 0 || value >= 1) return fail()
  return value
}
function next(now: number, frequency: PetSpeechSettings['frequency'], clock: PetSpeechClock) {
  const minimum = (frequency === 'low' ? 90 : 45) * 60_000
  const result = now + minimum + Math.floor(random(clock) * (minimum + 1))
  if (!timestamp(result)) return fail()
  return result
}
export function createPetSpeechState(clock: PetSpeechClock, initial: Partial<PetSpeechSettings> = {}): PetSpeechState {
  const config = settings({ ...PET_SPEECH_DEFAULTS, ...initial })
  const { now, day } = time(clock)
  return { version: 1, preferences: config, nextAt: config.enabled ? next(now, config.frequency, clock) : null, day, count: 0, recent: [], lastNow: now, suppressed: !config.enabled }
}
/** A preference change starts a fresh full cooldown; it never resets quota/history. */
export function configurePetSpeech(input: PetSpeechState, patch: Partial<PetSpeechSettings>, clock: PetSpeechClock): PetSpeechState {
  const state = parsePetSpeechState(input)
  if (!record(patch) || Object.keys(patch).some(key => !Object.hasOwn(PET_SPEECH_DEFAULTS, key))) return fail()
  const config = settings({ ...state.preferences, ...patch })
  if (Object.keys(config).every(key => config[key as keyof PetSpeechSettings] === state.preferences[key as keyof PetSpeechSettings])) return state
  const { now } = time(clock)
  return { ...state, preferences: config, nextAt: config.enabled ? next(now, config.frequency, clock) : null, lastNow: now, suppressed: !config.enabled }
}
/** Equal quiet endpoints mean all-day silence; an overnight interval wraps midnight. */
export function isPetSpeechQuiet(minuteOfDay: number, start: number, end: number): boolean {
  if (!minute(minuteOfDay) || !minute(start) || !minute(end)) return fail()
  return start === end || (start < end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end)
}
export function tickPetSpeech(input: PetSpeechState, environment: PetSpeechEnvironment, clock: PetSpeechClock): PetSpeechDecision {
  const state = parsePetSpeechState(input)
  if (!record(environment) || ['locked', 'asleep', 'fullscreen', 'visible', 'busy'].some(key => typeof environment[key] !== 'boolean') || (environment.resumed !== undefined && typeof environment.resumed !== 'boolean') || Object.keys(environment).some(key => !['locked', 'asleep', 'fullscreen', 'visible', 'busy', 'resumed'].includes(key))) return fail()
  const { now, day, minute: localMinute } = time(clock)
  const interrupted = environment.resumed === true || now < state.lastNow || now - state.lastNow > PET_SPEECH_RESUME_GAP_MS || day !== state.day
  // Never roll the day backward and accidentally replenish a spent daily budget.
  if (day > state.day && now >= state.lastNow) { state.day = day; state.count = 0 }
  state.lastNow = now
  const silent = (reason: PetSpeechReason): PetSpeechDecision => ({ state, speech: null, reason })
  const blocked = (reason: PetSpeechReason) => { state.suppressed = true; state.nextAt = null; return silent(reason) }
  if (!state.preferences.enabled) return blocked('disabled')
  if (state.preferences.pausedUntil !== null && now < state.preferences.pausedUntil) return blocked('paused')
  if (isPetSpeechQuiet(localMinute, state.preferences.quietStart, state.preferences.quietEnd)) return blocked('quiet')
  if (environment.locked || environment.asleep || environment.fullscreen || !environment.visible || environment.busy) return blocked('suppressed')
  if (interrupted || state.suppressed || state.nextAt === null) {
    state.suppressed = false; state.nextAt = next(now, state.preferences.frequency, clock)
    return silent('cooldown')
  }
  if (state.count >= PET_SPEECH_DAILY_LIMIT) return silent('daily-limit')
  if (now < state.nextAt) return silent('cooldown')
  const available = PET_SPEECH_LINES.filter(line => !state.recent.includes(line.id))
  const line = available[Math.floor(random(clock) * available.length)]!
  state.count++
  state.recent = [...state.recent, line.id].slice(-PET_SPEECH_RECENT_LIMIT)
  state.nextAt = next(now, state.preferences.frequency, clock)
  return { state, speech: { ...line }, reason: 'reserved' }
}

import { app, powerMonitor } from 'electron'
import { execFile, type ChildProcess } from 'node:child_process'
import { join, isAbsolute } from 'node:path'
export interface PetSpeechEnvironmentState {
  locked: boolean
  suspended: boolean
  fullscreen: boolean
  available: boolean
  reason: 'ready' | 'unsupported' | 'unavailable' | 'locked' | 'suspended'
}
interface ProbeResult {
  available: boolean
  fullscreen: boolean
}
export function parseSpeechEnvironmentProbe(text: string): ProbeResult {
  if (Buffer.byteLength(text) > 1024) throw Error('PET_ENVIRONMENT_INVALID')
  const v = JSON.parse(text) as Record<string, unknown>
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== 2 ||
    typeof v.available !== 'boolean' ||
    typeof v.fullscreen !== 'boolean'
  )
    throw Error('PET_ENVIRONMENT_INVALID')
  return { available: v.available, fullscreen: v.fullscreen }
}
export interface PetSpeechEnvironmentDeps {
  onChange?: (state: PetSpeechEnvironmentState) => void
  helperPath?: string
  /** Test seams; production uses the fixed bundled executable and Electron. */
  probe?: () => Promise<ProbeResult>
  platform?: NodeJS.Platform
  now?: () => number
}
export function createPetSpeechEnvironment(
  deps: PetSpeechEnvironmentDeps = {},
) {
  const platform = deps.platform ?? process.platform,
    now = deps.now ?? Date.now
  const helper =
    deps.helperPath ??
    join(
      app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked'),
      'out/native/pet-speech-environment',
    )
  let value: PetSpeechEnvironmentState = {
    locked: false,
    suspended: false,
    fullscreen: true,
    available: false,
    reason: platform === 'darwin' ? 'unavailable' : 'unsupported',
  }
  let disposed = false,
    revision = 0,
    last = -Infinity,
    pending: Promise<PetSpeechEnvironmentState> | null = null,
    child: ChildProcess | undefined
  const publish = (next: PetSpeechEnvironmentState) => {
    const changed = JSON.stringify(next) !== JSON.stringify(value)
    value = next
    if (changed) {
      try {
        deps.onChange?.({ ...value })
      } catch {
        /* Observer failures must not break suppression. */
      }
    }
  }
  const run =
    deps.probe ??
    (() =>
      new Promise<ProbeResult>((resolve, reject) => {
        if (!isAbsolute(helper)) {
          reject(Error('PET_ENVIRONMENT_INVALID'))
          return
        }
        child = execFile(
          helper,
          [],
          {
            timeout: 2000,
            maxBuffer: 1024,
            encoding: 'utf8',
            windowsHide: true,
          },
          (error, stdout) => {
            child = undefined
            if (error) {
              reject(Error('PET_ENVIRONMENT_UNAVAILABLE'))
              return
            }
            try {
              resolve(parseSpeechEnvironmentProbe(stdout))
            } catch {
              reject(Error('PET_ENVIRONMENT_INVALID'))
            }
          },
        )
      }))
  const invalidate = (patch: Partial<PetSpeechEnvironmentState>) => {
    revision++
    last = -Infinity
    publish({ ...value, ...patch, available: false })
    child?.kill()
  }
  const handlers = {
    'lock-screen': () => invalidate({ locked: true, reason: 'locked' }),
    'unlock-screen': () => invalidate({ locked: false, reason: 'unavailable' }),
    suspend: () => invalidate({ suspended: true, reason: 'suspended' }),
    resume: () => invalidate({ suspended: false, reason: 'unavailable' }),
    'user-did-resign-active': () =>
      invalidate({ locked: true, reason: 'locked' }),
    'user-did-become-active': () =>
      invalidate({ locked: false, reason: 'unavailable' }),
  }
  for (const [event, handler] of Object.entries(handlers))
    powerMonitor.on(event as 'suspend', handler)
  async function read(): Promise<PetSpeechEnvironmentState> {
    if (disposed || platform !== 'darwin' || !app.isReady())
      return { ...value, available: false }
    let idle: string
    try {
      idle = powerMonitor.getSystemIdleState(1)
    } catch {
      idle = 'unknown'
    }
    if (idle === 'locked' && !value.locked)
      invalidate({ locked: true, reason: 'locked' })
    if (value.locked || value.suspended) return { ...value }
    if (idle === 'unknown') {
      publish({ ...value, available: false, reason: 'unavailable' })
      return { ...value }
    }
    if (now() - last < 1000) return { ...value }
    if (pending) return pending
    const ticket = revision
    pending = (async () => {
      try {
        const result = await run()
        if (!disposed && ticket === revision) {
          last = now()
          publish({
            ...value,
            ...result,
            reason: result.available ? 'ready' : 'unavailable',
          })
        }
      } catch {
        if (!disposed && ticket === revision) {
          last = now()
          publish({
            ...value,
            available: false,
            fullscreen: true,
            reason: 'unavailable',
          })
        }
      }
      return { ...value }
    })()
    try {
      return await pending
    } finally {
      pending = null
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  function setEnabled(enabled: boolean) {
    if (disposed || (enabled && timer)) return
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (!enabled) {
      revision++
      last = -Infinity
      child?.kill()
      publish({
        ...value,
        available: false,
        reason: platform === 'darwin' ? 'unavailable' : 'unsupported',
      })
      return
    }
    timer = setInterval(() => {
      void read()
    }, 5000)
    timer.unref()
    void read()
  }
  return {
    read,
    setEnabled,
    dispose() {
      if (disposed) return
      disposed = true
      revision++
      if (timer) clearInterval(timer)
      child?.kill()
      for (const [event, handler] of Object.entries(handlers))
        powerMonitor.removeListener(event as 'suspend', handler)
      value = { ...value, available: false, reason: 'unavailable' }
    },
  }
}

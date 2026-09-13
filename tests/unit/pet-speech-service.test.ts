import { describe, it, expect } from 'vitest'
import { createPetSpeechState, type PetSpeechState } from '@memo/domain'
import {
  createPetSpeechService,
  type PetSpeechServiceDeps,
} from '../../apps/desktop/src/main/pet/speech-service'
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
function fixture(extra: Partial<PetSpeechServiceDeps> = {}) {
  let now = Date.parse('2026-09-13T10:00:00Z')
  const clock = {
    now: () => now,
    random: () => 0,
    localTime: (ms: number) => ({
      day: new Date(ms).toISOString().slice(0, 10),
      minute: new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(),
    }),
  }
  let saved: PetSpeechState | null = null
  let callback: (() => void) | undefined
  let environment = {
    locked: false,
    suspended: false,
    fullscreen: false,
    available: true,
  }
  let display = { visible: true, busy: false }
  const delivered: string[] = [],
    canceled: string[] = [],
    monitors: boolean[] = []
  let saveImpl = async (state: PetSpeechState) => {
    saved = structuredClone(state)
  }
  const service = createPetSpeechService({
    store: { load: async () => saved, save: (state) => saveImpl(state) },
    clock,
    environment: async () => ({ ...environment }),
    display: () => ({ ...display }),
    deliver: (text) => {
      delivered.push(text)
      return `id-${delivered.length}`
    },
    cancel: (id) => {
      canceled.push(id)
    },
    monitor: (value) => {
      monitors.push(value)
    },
    schedule: (next) => {
      callback = next
      return () => {
        if (callback === next) callback = undefined
      }
    },
    ...extra,
  })
  return {
    service,
    clock,
    delivered,
    canceled,
    monitors,
    get saved() {
      return saved
    },
    get timer() {
      return !!callback
    },
    setSave(fn: typeof saveImpl) {
      saveImpl = fn
    },
    setEnv(p: Partial<typeof environment>) {
      environment = { ...environment, ...p }
    },
    setDisplay(p: Partial<typeof display>) {
      display = { ...display, ...p }
    },
    setNow(value: number) {
      now = value
    },
    advance: async (ms = 60_000) => {
      now += ms
      const next = callback
      callback = undefined
      next?.()
      await flush()
    },
  }
}
describe('durable pet speech service', () => {
  it('defaults off with no timer, reserves before emitting, cancels on disable', async () => {
    const f = fixture()
    await f.service.ready
    expect(f.timer).toBe(false)
    expect(f.delivered).toEqual([])
    expect(await f.service.configure({ enabled: true })).toBe(true)
    for (let i = 0; i < 45; i++) await f.advance()
    expect(f.delivered).toHaveLength(1)
    expect(f.saved?.count).toBe(1)
    expect(await f.service.configure({ enabled: false })).toBe(true)
    expect(f.canceled).toContain('id-1')
    expect(f.timer).toBe(false)
    await f.advance(100000)
    expect(f.delivered).toHaveLength(1)
    f.service.dispose()
  })
  it('a locked or hidden transition cancels pending presentation and resumes a full cooldown', async () => {
    const f = fixture()
    await f.service.ready
    await f.service.configure({ enabled: true })
    for (let i = 0; i < 45; i++) await f.advance()
    f.setEnv({ locked: true })
    await f.service.wake()
    expect(f.canceled).toContain('id-1')
    expect(f.service.snapshot().status).toBe('suppressed')
    await f.advance(8 * 60 * 60_000)
    f.setEnv({ locked: false })
    await f.service.wake()
    expect(f.delivered).toHaveLength(1)
    expect(f.service.snapshot().nextAt).toBe(f.clock.now() + 45 * 60_000)
    f.setDisplay({ visible: false })
    await f.service.wake()
    expect(f.timer).toBe(false)
    f.service.dispose()
  })
  it('a failed quota save never emits or schedules further work', async () => {
    const f = fixture()
    await f.service.ready
    await f.service.configure({ enabled: true })
    for (let i = 0; i < 44; i++) await f.advance()
    f.setSave(async () => {
      throw Error('disk full')
    })
    await f.advance()
    expect(f.delivered).toEqual([])
    expect(f.service.snapshot().status).toBe('error')
    expect(f.timer).toBe(false)
    f.service.dispose()
  })
  it('disable during an in-flight reservation fences delivery before queued configure runs', async () => {
    const f = fixture()
    await f.service.ready
    await f.service.configure({ enabled: true })
    for (let i = 0; i < 44; i++) await f.advance()
    let release!: () => void
    f.setSave(async (state) => {
      if (state.count === 1)
        await new Promise<void>((resolve) => {
          release = resolve
        })
    })
    await f.advance()
    const disabled = f.service.configure({ enabled: false })
    release()
    await flush()
    // Configure also persists the consumed quota. Release its synthetic disk delay.
    release()
    await flush()
    release()
    await disabled
    expect(f.delivered).toEqual([])
    expect(f.timer).toBe(false)
    f.service.dispose()
  })
  it('startup never catches up an overdue record and rejects excessive pauses', async () => {
    const f = fixture()
    await f.service.ready
    expect(
      await f.service.configure({
        pausedUntil: f.clock.now() + 25 * 60 * 60_000,
      }),
    ).toBe(false)
    expect(f.service.snapshot().preferences.enabled).toBe(false)
    const stored = createPetSpeechState(f.clock, { enabled: true })
    stored.nextAt = f.clock.now() - 1
    const emitted: string[] = []
    const service = createPetSpeechService({
      clock: f.clock,
      store: { load: async () => stored, save: async () => {} },
      environment: async () => ({
        available: true,
        locked: false,
        suspended: false,
        fullscreen: false,
      }),
      display: () => ({ visible: true, busy: false }),
      deliver: (text) => {
        emitted.push(text)
        return 'id'
      },
      cancel: () => {},
      schedule: () => () => {},
    })
    await service.ready
    expect(emitted).toEqual([])
    expect(service.snapshot().nextAt).toBe(f.clock.now() + 45 * 60_000)
    service.dispose()
    f.service.dispose()
  })
  it('does not emit when quota persistence crosses into quiet hours', async () => {
    const f = fixture()
    await f.service.ready
    await f.service.configure({ enabled: true })
    for (let i = 0; i < 44; i++) await f.advance()
    f.setSave(async (state) => {
      if (state.count === 1) f.setNow(Date.parse('2026-09-13T22:00:00Z'))
    })
    await f.advance()
    expect(f.delivered).toEqual([])
    f.service.dispose()
  })
  it('snapshots a configuration patch before its asynchronous turn', async () => {
    const f = fixture()
    await f.service.ready
    const patch = { enabled: true }
    const result = f.service.configure(patch)
    patch.enabled = false
    expect(await result).toBe(true)
    expect(f.service.snapshot().preferences.enabled).toBe(true)
    f.service.dispose()
  })
  it('stops environment polling when configuration persistence fails', async () => {
    const f = fixture()
    await f.service.ready
    await f.service.configure({ enabled: true })
    expect(f.monitors.at(-1)).toBe(true)
    f.setSave(async () => {
      throw Error('disk full')
    })
    expect(await f.service.configure({ frequency: 'low' })).toBe(false)
    expect(f.timer).toBe(false)
    expect(f.monitors.at(-1)).toBe(false)
    f.service.dispose()
  })
})

describe('asynchronous context speech in the durable scheduler', () => {
  it('reserves once before preparing and cancels late contextual output on disable', async () => {
    let resolve!: (v: { text: string; contextId: string }) => void
    let signal: AbortSignal | undefined
    let preparedCount = 0,
      sent = 0
    const f = fixture({
      prepare: async (_text, incoming) => {
        signal = incoming
        preparedCount++
        expect(f.saved?.count).toBe(1)
        return new Promise((r) => {
          resolve = r
        })
      },
      deliverPrepared: async () => {
        sent++
        return 'context-1'
      },
    })
    await f.service.ready
    await f.service.configure({ enabled: true })
    for (let i = 0; i < 45; i++) await f.advance()
    expect(preparedCount).toBe(1)
    const disabling = f.service.configure({ enabled: false })
    expect(signal?.aborted).toBe(true)
    resolve({ text: 'context', contextId: 'private' })
    await disabling
    await flush()
    expect(sent).toBe(0)
    expect(f.delivered).toEqual([])
    expect(f.saved?.count).toBe(1)
    f.service.dispose()
  })
  it('rechecks quiet time at the final asynchronous enqueue boundary', async () => {
    let emitted = false
    const f = fixture({
      prepare: async (text) => ({ text }),
      deliverPrepared: async (_input, _signal, guard) => {
        f.setNow(Date.parse('2026-09-13T22:00:00Z'))
        emitted = await guard()
        return emitted ? 'late' : null
      },
    })
    await f.service.ready
    await f.service.configure({ enabled: true })
    for (let i = 0; i < 45; i++) await f.advance()
    expect(emitted).toBe(false)
    expect(f.saved?.count).toBe(1)
    expect(f.delivered).toEqual([])
    f.service.dispose()
  })
  it('a model failure fallback uses the existing reservation and only one delivery', async () => {
    let emitted = 0
    const f = fixture({
      prepare: async (text) => ({ text }),
      deliverPrepared: async (_input, _signal, guard) => {
        if (!(await guard())) return null
        emitted++
        return 'fallback-1'
      },
    })
    await f.service.ready
    await f.service.configure({ enabled: true })
    for (let i = 0; i < 45; i++) await f.advance()
    expect(emitted).toBe(1)
    expect(f.saved?.count).toBe(1)
    expect(f.delivered).toEqual([])
    f.service.dispose()
  })
})

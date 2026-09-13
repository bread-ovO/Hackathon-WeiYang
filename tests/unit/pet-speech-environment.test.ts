import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  idle: 'active',
  ready: true,
  power: undefined as unknown as EventEmitter,
}))
vi.mock('../../apps/desktop/node_modules/electron', () => ({
  app: { getAppPath: () => '/fake', isReady: () => mock.ready },
  powerMonitor: new Proxy(
    {},
    {
      get: (_target, key) =>
        key === 'getSystemIdleState'
          ? () => mock.idle
          : (mock.power as any)[key].bind(mock.power),
    },
  ),
}))
import {
  createPetSpeechEnvironment,
  parseSpeechEnvironmentProbe,
} from '../../apps/desktop/src/main/pet/speech-environment'
beforeEach(() => {
  mock.power = new EventEmitter()
  mock.idle = 'active'
  mock.ready = true
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})
describe('speech suppression environment', () => {
  it('samples initial lock and fails closed on unsupported/unknown', async () => {
    const probe = vi.fn(async () => ({ available: true, fullscreen: false }))
    mock.idle = 'locked'
    const env = createPetSpeechEnvironment({ platform: 'darwin', probe })
    expect(await env.read()).toMatchObject({ locked: true, available: false })
    expect(probe).not.toHaveBeenCalled()
    env.dispose()
    mock.idle = 'active'
    const other = createPetSpeechEnvironment({ platform: 'win32', probe })
    expect(await other.read()).toMatchObject({
      available: false,
      reason: 'unsupported',
    })
    other.dispose()
  })
  it('lock and suspend fence late probes, resume does not replay old availability', async () => {
    let finish!: (value: { available: boolean; fullscreen: boolean }) => void
    const env = createPetSpeechEnvironment({
      platform: 'darwin',
      probe: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    })
    const read = env.read()
    mock.power.emit('lock-screen')
    finish({ available: true, fullscreen: false })
    expect(await read).toMatchObject({ available: false, locked: true })
    mock.power.emit('unlock-screen')
    mock.power.emit('suspend')
    expect(await env.read()).toMatchObject({
      suspended: true,
      available: false,
    })
    env.dispose()
    expect(mock.power.eventNames()).toHaveLength(0)
  })
  it('coalesces and caches probes briefly, reports fullscreen and failures', async () => {
    let tick = 1000
    const probe = vi.fn(async () => ({ available: true, fullscreen: true })),
      onChange = vi.fn()
    const env = createPetSpeechEnvironment({
      platform: 'darwin',
      probe,
      onChange,
      now: () => tick,
    })
    expect(await env.read()).toMatchObject({
      available: true,
      fullscreen: true,
    })
    await env.read()
    expect(probe).toHaveBeenCalledTimes(1)
    tick += 1001
    probe.mockRejectedValueOnce(Error('private detail'))
    expect(await env.read()).toMatchObject({
      available: false,
      reason: 'unavailable',
    })
    expect(JSON.stringify(onChange.mock.calls)).not.toContain('private detail')
    env.dispose()
  })
  it('accepts only bounded boolean output', () => {
    expect(
      parseSpeechEnvironmentProbe('{"available":true,"fullscreen":false}'),
    ).toEqual({ available: true, fullscreen: false })
    for (const s of [
      '{}',
      'null',
      '{"available":true,"fullscreen":false,"title":"secret"}',
      'x'.repeat(1025),
    ])
      expect(() => parseSpeechEnvironmentProbe(s)).toThrow()
  })
})

it('starts disabled and removes polling and rejects late probes when disabled', async () => {
  const probe = vi.fn(async () => ({ available: true, fullscreen: false }))
  const env = createPetSpeechEnvironment({ platform: 'darwin', probe })
  await vi.advanceTimersByTimeAsync(15000)
  expect(probe).not.toHaveBeenCalled()
  env.setEnabled(true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(probe.mock.calls.length).toBeGreaterThan(1)
  env.setEnabled(false)
  const calls = probe.mock.calls.length
  await vi.advanceTimersByTimeAsync(15000)
  expect(probe).toHaveBeenCalledTimes(calls)
  expect(vi.getTimerCount()).toBe(0)
  env.dispose()
})

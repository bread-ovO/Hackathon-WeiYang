import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { symlinkOrSkip } from './helpers/symlink-or-skip'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createPetVoiceService,
  type PetVoiceServiceDeps,
} from '../../apps/desktop/src/main/pet/voice-service'
import { createPetVoiceStore } from '../../apps/desktop/src/main/pet/voice-store'
import type {
  PetVoicePreferences,
  PetVoicePcm,
} from '../../packages/contracts/src/index'
const prefs: PetVoicePreferences = {
    version: 1,
    enabled: true,
    voiceId: 'local',
    volume: 0.6,
    rate: 1,
  },
  pcm: PetVoicePcm = {
    sampleRate: 8000,
    channels: 1,
    format: 'f32le',
    frames: 1,
    data: 'AAAAAA==',
  }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function flush() {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}
function fixture(
  patch: Partial<PetVoiceServiceDeps> = {},
  initial: PetVoicePreferences | null = prefs,
) {
  let current: { id: string; kind: 'bubble'; text: string } | null = {
      id: 'one',
      kind: 'bubble',
      text: '合成话语',
    },
    saved = initial
  const deps: PetVoiceServiceDeps = {
    provider: {
      voices: vi.fn(async () => [
        { id: 'local', name: '本机', language: 'zh-CN' },
      ]),
      synthesize: vi.fn(async () => pcm),
    },
    store: {
      load: vi.fn(async () => saved),
      save: vi.fn(async (value) => {
        saved = structuredClone(value)
      }),
    },
    current: () => current,
    guard: vi.fn(async () => true),
    currentAllowed: vi.fn(() => true),
    notifyStop: vi.fn(),
    activity: vi.fn(),
    ...patch,
  }
  const service = createPetVoiceService(deps)
  return {
    service,
    deps,
    setCurrent(id: string | null) {
      current = id ? { id, kind: 'bubble', text: '合成话语' } : null
    },
    observe() {
      service.observe(current)
    },
    get saved() {
      return saved
    },
  }
}
afterEach(() => vi.useRealTimers())
describe('voice service generations', () => {
  it('default disabled never synthesizes and enable applies only next bubble', async () => {
    const f = fixture({}, null)
    await f.service.ready
    f.observe()
    await flush()
    expect(f.deps.provider.synthesize).not.toHaveBeenCalled()
    await f.service.configure(1, {
      enabled: true,
      voiceId: 'local',
      volume: 0.6,
      rate: 1,
    })
    f.observe()
    await flush()
    expect(f.deps.provider.synthesize).not.toHaveBeenCalled()
    f.setCurrent('two')
    f.observe()
    await flush()
    expect(f.service.playback().status).toBe('ready')
    f.service.dispose()
  })
  it('returns audio once per generation, reports playback without clearing text, no replay after stop', async () => {
    const f = fixture()
    await f.service.ready
    f.observe()
    await flush()
    const p = f.service.playback()
    expect(p.status).toBe('ready')
    const input = { id: p.id!, version: p.version }
    expect((await f.service.audio(input))?.pcm).toEqual(pcm)
    expect(await f.service.audio(input)).toBeNull()
    f.service.report({ ...input, status: 'playing' })
    expect(f.service.playback().status).toBe('playing')
    f.service.stopNow()
    f.observe()
    await flush()
    expect(f.deps.provider.synthesize).toHaveBeenCalledOnce()
    expect(await f.service.audio(input)).toBeNull()
    expect(f.deps.current()?.id).toBe('one')
    f.service.dispose()
  })
  it('stops before startup ready and rejects late synth result on hide', async () => {
    const load = deferred<PetVoicePreferences | null>(),
      early = fixture({ store: { load: () => load.promise, save: vi.fn() } })
    early.observe()
    early.service.stopNow()
    load.resolve(prefs)
    await flush()
    expect(early.deps.provider.synthesize).not.toHaveBeenCalled()
    early.service.dispose()
    const f = fixture(),
      d = deferred<PetVoicePcm>()
    vi.mocked(f.deps.provider.synthesize).mockReturnValueOnce(d.promise)
    await f.service.ready
    f.observe()
    await flush()
    f.setCurrent(null)
    f.service.observe(null)
    d.resolve(pcm)
    await flush()
    expect(f.service.playback().id).toBeNull()
    f.service.dispose()
  })
  it('fences cancelled generation even when model changes back to same presentation', async () => {
    const f = fixture(),
      d = deferred<PetVoicePcm>()
    vi.mocked(f.deps.provider.synthesize).mockReturnValueOnce(d.promise)
    await f.service.ready
    f.observe()
    await flush()
    f.service.stopNow()
    d.resolve(pcm)
    await flush()
    expect(f.service.playback().status).not.toBe('ready')
    expect(f.deps.notifyStop).toHaveBeenCalled()
    f.service.dispose()
  })
  it('renderer close while synthesizing cancels before audio is taken and activity cannot reenter forever',async()=>{
    const f=fixture(),d=deferred<PetVoicePcm>();vi.mocked(f.deps.provider.synthesize).mockReturnValueOnce(d.promise)
    vi.mocked(f.deps.activity).mockImplementation(active=>{if(!active)f.service.stopNow()})
    await f.service.ready;f.observe();await flush();const p=f.service.playback();expect(p.status).toBe('synthesizing')
    f.service.report({id:p.id!,version:p.version,status:'ended'});d.resolve(pcm);await flush()
    expect(f.service.playback().id).toBeNull();expect(f.deps.activity).toHaveBeenCalledTimes(2)
    f.service.dispose()
  })
  it('checks environment during ready/playback every second', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.ready
    f.observe()
    await flush()
    expect(f.service.playback().status).toBe('ready')
    vi.mocked(f.deps.guard).mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.service.playback().id).toBeNull()
    expect(f.deps.activity).toHaveBeenLastCalledWith(false)
    f.service.dispose()
  })
  it('expires bounded audio and never restarts it on repeated observation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.ready
    f.observe()
    await flush()
    await vi.advanceTimersByTimeAsync(12002)
    expect(f.service.playback().id).toBeNull()
    f.observe()
    await flush()
    expect(f.deps.provider.synthesize).toHaveBeenCalledOnce()
    f.service.dispose()
  })
  it('rechecks environment/generation after deferred audio request guard', async () => {
    const f = fixture()
    await f.service.ready
    f.observe()
    await flush()
    const p = f.service.playback(),
      d = deferred<boolean>()
    vi.mocked(f.deps.guard).mockReturnValueOnce(d.promise)
    const audio = f.service.audio({ id: p.id!, version: p.version })
    await Promise.resolve()
    f.service.stopNow()
    d.resolve(true)
    expect(await audio).toBeNull()
    f.service.dispose()
  })
  it('serializes configuration CAS and rejects unavailable explicit voice', async () => {
    const f = fixture()
    await f.service.ready
    const results = await Promise.allSettled([
      f.service.configure(1, { ...prefs, enabled: false }),
      f.service.configure(1, { ...prefs, volume: 0.4 }),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect(f.saved!.version).toBe(2)
    await expect(
      f.service.configure(2, {
        enabled: true,
        voiceId: 'not-installed',
        volume: 0.5,
        rate: 1,
      }),
    ).rejects.toThrow('PET_VOICE_UNAVAILABLE')
    f.service.dispose()
  })
  it('fails closed on storage corruption/save failure and never exposes raw cause', async () => {
    const f = fixture({
      store: {
        load: async () => {
          throw Error('private path')
        },
        save: vi.fn(),
      },
    })
    await f.service.ready
    expect((await f.service.state()).error).toBe('PET_VOICE_STORAGE')
    f.observe()
    await flush()
    expect(f.deps.provider.synthesize).not.toHaveBeenCalled()
    f.service.dispose()
    const g = fixture()
    await g.service.ready
    vi.mocked(g.deps.store.save).mockRejectedValueOnce(Error('private disk'))
    await expect(
      g.service.configure(1, {
        enabled: false,
        voiceId: null,
        volume: 0.6,
        rate: 1,
      }),
    ).rejects.toThrow('PET_VOICE_STORAGE')
    expect((await g.service.state()).status).toBe('error')
    g.service.dispose()
  })
  it('provider failure stays text-only and is not retried by polling', async () => {
    const f = fixture()
    vi.mocked(f.deps.provider.synthesize).mockRejectedValue(
      Error('raw OS secret'),
    )
    await f.service.ready
    f.observe()
    await flush()
    expect((await f.service.state()).error).toBe('PET_VOICE_UNAVAILABLE')
    f.observe()
    await flush()
    expect(f.deps.provider.synthesize).toHaveBeenCalledOnce()
    expect(f.deps.current()?.text).toBe('合成话语')
    f.service.dispose()
  })
})
describe('voice preferences isolated store', () => {
  it('roundtrips atomic settings, rejects symlinks and corrupt text', async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), 'bugu-voice-pref-'))
    try {
      const path = join(dir, 'voice.json'),
        s = createPetVoiceStore(path)
      expect(await s.load()).toBeNull()
      await s.save(prefs)
      expect(await s.load()).toEqual(prefs)
      await symlinkOrSkip(ctx, path, join(dir, 'link'))
      await expect(
        createPetVoiceStore(join(dir, 'link')).load(),
      ).rejects.toThrow('PET_VOICE_STORAGE')
      await writeFile(path, '{"bad":true}')
      await expect(s.load()).rejects.toThrow('PET_VOICE_STORAGE')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

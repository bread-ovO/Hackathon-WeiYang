import { describe, expect, it, vi } from 'vitest'
import {
  createPetAudioPlayer,
  pcmLipLevel,
} from '../../apps/desktop/src/renderer/src/pet-audio'
import { createDeclaredLipSync } from '../../apps/desktop/src/renderer/src/pet-lip-sync'
import type { PetVoiceAudio } from '../../packages/contracts/src/pet-voice'
import { createPetPresentationPlayer } from '../../apps/desktop/src/renderer/src/pet-bubble'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function payload(): PetVoiceAudio {
  const bytes = Buffer.alloc(8000 * 4)
  for (let i = 0; i < 8000; i++) bytes.writeFloatLE(i < 4000 ? 0.2 : 0, i * 4)
  return {
    id: 'synthetic-bubble',
    version: 1,
    volume: 0.5,
    pcm: {
      sampleRate: 8000,
      channels: 1,
      format: 'f32le',
      frames: 8000,
      data: bytes.toString('base64'),
    },
  }
}
function fixture(
  options: {
    audio?: () => Promise<PetVoiceAudio | null>
    resume?: () => Promise<void>
  } = {},
) {
  const source = {
    buffer: null as unknown,
    onended: null as (() => void) | null,
    start: vi.fn(),
    stop: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
  const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() }
  const buffer = { copyToChannel: vi.fn() }
  const context = {
    currentTime: 10,
    state: 'running',
    destination: {},
    resume: options.resume ?? vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createBuffer: vi.fn(() => buffer),
    createBufferSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
  }
  const deps = {
    audio: vi.fn(options.audio ?? (async () => payload())),
    report: vi.fn(async () => {}),
    lip: vi.fn(),
    changed: vi.fn(),
    context: vi.fn(() => context as unknown as AudioContext),
  }
  return {
    player: createPetAudioPlayer(deps),
    deps,
    context,
    source,
    gain,
    buffer,
  }
}
const playback = {
  id: 'synthetic-bubble',
  version: 1,
  status: 'ready' as const,
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('PCM playback without a speaker device', () => {
  it('audio completion leaves the text bubble open until its own close lifecycle', async () => {
    const f = fixture(),
      ack = vi.fn(async () => {})
    let close!: () => void
    const bubble = createPetPresentationPlayer({
      show: (_text, done) => {
        close = done
      },
      hide: () => f.player.stop(),
      play: async () => ({ status: 'unavailable' }),
      currentAction: () => ({ id: null, kind: 'idle' }),
      ack,
    })
    bubble.sync({ id: playback.id, kind: 'bubble', text: '合成话语' })
    f.player.sync(playback, playback.id)
    await flush()
    f.source.onended!()
    expect(bubble.isBubbleOpen(playback.id)).toBe(true)
    expect(ack).not.toHaveBeenCalled()
    close()
    await flush()
    expect(bubble.isBubbleOpen(playback.id)).toBe(false)
    expect(ack).toHaveBeenCalledExactlyOnceWith({
      id: playback.id,
      status: 'done',
    })
    bubble.clear()
    f.player.dispose()
  })
  it('uses decoded PCM, gain and AudioContext sample position for the mouth', async () => {
    const f = fixture()
    f.player.sync(playback, playback.id)
    await flush()
    expect(f.context.createBuffer).toHaveBeenCalledWith(1, 8000, 8000)
    expect(f.buffer.copyToChannel.mock.calls[0]?.[0]).toBeInstanceOf(
      Float32Array,
    )
    expect(f.source.start).toHaveBeenCalledWith(10)
    expect(f.gain.gain.value).toBe(0.5)
    expect(f.deps.report).toHaveBeenCalledWith({
      id: playback.id,
      version: 1,
      status: 'playing',
    })
    f.context.currentTime = 10.25
    f.player.tick()
    expect(f.deps.lip).toHaveBeenLastCalledWith(expect.closeTo(0.3, 5))
    f.context.currentTime = 10.8
    f.player.tick()
    expect(f.deps.lip).toHaveBeenLastCalledWith(0)
    f.source.onended!()
    expect(f.deps.report).toHaveBeenLastCalledWith({
      id: playback.id,
      version: 1,
      status: 'ended',
    })
    expect(f.context.close).toHaveBeenCalledOnce()
    expect(f.source.buffer).toBeNull()
    expect(f.deps.lip).toHaveBeenLastCalledWith(null)
  })
  it('fetches each id/generation once and never replays after a local stop', async () => {
    const f = fixture()
    f.player.sync(playback, playback.id)
    await flush()
    f.player.sync(playback, playback.id)
    f.player.stop()
    f.player.sync(playback, playback.id)
    await flush()
    expect(f.deps.audio).toHaveBeenCalledOnce()
    expect(f.source.start).toHaveBeenCalledOnce()
    expect(f.source.disconnect).toHaveBeenCalledOnce()
    expect(f.gain.disconnect).toHaveBeenCalledOnce()
  })
  it('does not start a delayed fetch after stop, model change or disposal', async () => {
    for (const action of ['stop', 'change', 'dispose']) {
      const pending = deferred<PetVoiceAudio | null>()
      const f = fixture({ audio: () => pending.promise })
      f.player.sync(playback, playback.id)
      if (action === 'change') f.player.sync(playback, 'other-bubble')
      else if (action === 'dispose') f.player.dispose()
      else f.player.stop()
      pending.resolve(payload())
      await flush()
      expect(f.deps.context).not.toHaveBeenCalled()
      expect(f.source.start).not.toHaveBeenCalled()
      expect(f.deps.report).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'playing' }),
      )
    }
  })
  it('closes a context cancelled during resume and cannot later start', async () => {
    const pending = deferred<void>()
    const f = fixture({ resume: () => pending.promise })
    f.player.sync(playback, playback.id)
    await flush()
    f.player.stop()
    pending.resolve()
    await flush()
    expect(f.context.close).toHaveBeenCalledOnce()
    expect(f.source.start).not.toHaveBeenCalled()
  })
  it('rejects wrong identities and malformed/nonfinite PCM before creating audio', async () => {
    for (const kind of ['identity', 'nan', 'length']) {
      const p = payload()
      if (kind === 'identity') p.id = 'other'
      if (kind === 'length') p.pcm.frames++
      if (kind === 'nan') {
        const bytes = Buffer.from(p.pcm.data, 'base64')
        bytes.writeFloatLE(NaN, 0)
        p.pcm.data = bytes.toString('base64')
      }
      const f = fixture({ audio: async () => p })
      f.player.sync(playback, playback.id)
      await flush()
      expect(f.deps.context).not.toHaveBeenCalled()
      expect(f.deps.report).toHaveBeenLastCalledWith({
        id: playback.id,
        version: 1,
        status: 'error',
      })
    }
  })
  it('does not fetch synthesizing, mismatched or hidden presentations', async () => {
    const f = fixture()
    f.player.sync({ ...playback, status: 'synthesizing' }, playback.id)
    f.player.sync(playback, null)
    f.player.sync(playback, 'other')
    await flush()
    expect(f.deps.audio).not.toHaveBeenCalled()
  })
  it('silence and volume zero cannot manufacture mouth motion', () => {
    expect(pcmLipLevel(new Float32Array(8000), 8000, 0.2, 1)).toBe(0)
    expect(pcmLipLevel(new Float32Array(8000).fill(0.5), 8000, 0.2, 0)).toBe(0)
    expect(pcmLipLevel(new Float32Array(8000).fill(0.5), 8000, 2, 1)).toBe(0)
  })
})

describe('only declared, real Live2D lip parameters', () => {
  it('rejects phantom IDs and invalid ranges, clamps real values and releases overlay', () => {
    const ids = [{}, {}, {}],
      phantom = {}
    const set = vi.fn()
    const lips = createDeclaredLipSync(
      {
        getParameterCount: () => 3,
        getParameterValueByIndex: () => 0,
        getParameterId: (i) => ids[i]!,
        getParameterMinimumValue: (i) => (i === 2 ? NaN : 0),
        getParameterMaximumValue: () => 2,
        setParameterValueByIndex: set,
      },
      [ids[1]!, ids[2]!, phantom],
    )
    expect(lips.available).toBe(true)
    lips.set(0.25)
    lips.apply()
    expect(set).toHaveBeenCalledExactlyOnceWith(1, 0.5)
    lips.set(4)
    lips.apply()
    expect(set).toHaveBeenLastCalledWith(1, 2)
    set.mockClear()
    lips.set(null)
    lips.apply()
    expect(set).not.toHaveBeenCalled()
    lips.set(NaN)
    lips.apply()
    expect(set).not.toHaveBeenCalled()
  })
  it('models without a matching declared lip group stay audio-only', () => {
    const id = {},
      set = vi.fn()
    const lips = createDeclaredLipSync(
      {
        getParameterCount: () => 1,
        getParameterValueByIndex: () => 0,
        getParameterId: () => id,
        getParameterMinimumValue: () => 0,
        getParameterMaximumValue: () => 1,
        setParameterValueByIndex: set,
      },
      [{}],
    )
    expect(lips.available).toBe(false)
    lips.set(1)
    lips.apply()
    expect(set).not.toHaveBeenCalled()
  })
})

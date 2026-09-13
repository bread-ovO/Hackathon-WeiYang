import { parsePetVoicePcm } from '@memo/contracts/pet-voice-pcm'
import type { PetVoiceAudio, PetVoicePlayback } from '@memo/contracts'

export interface PetAudioDeps {
  audio(input: { id: string; version: number }): Promise<PetVoiceAudio | null>
  report(input: {
    id: string
    version: number
    status: 'playing' | 'ended' | 'error'
  }): Promise<void>
  lip(level: number | null): void
  changed(playing: boolean): void
  context?: () => AudioContext
}

/** Sample the PCM at the AudioContext playback clock, including the actual gain.
 * There is no text timing or generated oscillator driving the mouth. */
export function pcmLipLevel(
  samples: Float32Array,
  sampleRate: number,
  elapsed: number,
  volume: number,
) {
  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    !Number.isFinite(volume) ||
    volume <= 0
  )
    return 0
  const end = Math.min(samples.length, Math.floor(elapsed * sampleRate))
  const begin = Math.max(0, end - Math.ceil(sampleRate * 0.02))
  if (end <= begin || elapsed * sampleRate >= samples.length) return 0
  let sum = 0
  for (let i = begin; i < end; i++) sum += samples[i]! * samples[i]!
  return Math.min(1, Math.sqrt(sum / (end - begin)) * Math.min(1, volume) * 3)
}

/** Single-use host generation. Closing audio never acknowledges the text bubble. */
export function createPetAudioPlayer(deps: PetAudioDeps) {
  let generation = 0,
    disposed = false
  let active: {
    id: string
    version: number
    context?: AudioContext
    source?: AudioBufferSourceNode
    gain?: GainNode
    samples?: Float32Array
    rate: number
    volume: number
    startedAt: number
    playing: boolean
  } | null = null
  const seen = new Set<string>()
  const key = (id: string, version: number) => `${version}:${id}`
  function report(
    item: { id: string; version: number },
    status: 'playing' | 'ended' | 'error',
  ) {
    void deps
      .report({ id: item.id, version: item.version, status })
      .catch(() => {})
  }
  function stop(status: 'ended' | 'error' = 'ended') {
    generation++
    const item = active
    active = null
    if (item) {
      if (item.source) {
        item.source.onended = null
        try {
          item.source.stop()
        } catch {
          /* already ended */
        }
        item.source.disconnect()
        item.source.buffer = null
      }
      item.gain?.disconnect()
      if (item.context) void item.context.close().catch(() => {})
      item.samples = undefined
      report(item, status)
    }
    deps.lip(null)
    deps.changed(false)
  }
  async function start(id: string, version: number) {
    stop()
    const ticket = generation
    const item: NonNullable<typeof active> = {
      id,
      version,
      rate: 0,
      volume: 0,
      startedAt: 0,
      playing: false,
    }
    active = item
    try {
      const audio = await deps.audio({ id, version })
      if (disposed || ticket !== generation || active !== item) return
      if (
        !audio ||
        audio.id !== id ||
        audio.version !== version ||
        !Number.isFinite(audio.volume) ||
        audio.volume < 0 ||
        audio.volume > 1
      )
        throw Error('INVALID_PCM')
      const pcm = parsePetVoicePcm(audio.pcm)
      const raw = atob(pcm.data),
        bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
      const view = new DataView(bytes.buffer),
        samples = new Float32Array(pcm.frames)
      for (let i = 0; i < samples.length; i++)
        samples[i] = view.getFloat32(i * 4, true)
      const context = (deps.context ?? (() => new AudioContext()))()
      item.context = context
      await context.resume()
      if (disposed || ticket !== generation || active !== item) return
      if (context.state !== 'running') throw Error('AUDIO_UNAVAILABLE')
      const buffer = context.createBuffer(1, pcm.frames, pcm.sampleRate)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource(),
        gain = context.createGain()
      item.source = source
      item.gain = gain
      item.samples = samples
      item.rate = pcm.sampleRate
      item.volume = audio.volume
      source.buffer = buffer
      gain.gain.value = audio.volume
      source.connect(gain)
      gain.connect(context.destination)
      source.onended = () => {
        if (active === item) stop()
      }
      item.startedAt = context.currentTime
      source.start(item.startedAt)
      item.playing = true
      deps.changed(true)
      report(item, 'playing')
    } catch {
      if (active === item && ticket === generation) stop('error')
    }
  }
  return {
    sync(
      playback: PetVoicePlayback | undefined,
      presentationId: string | null,
    ) {
      if (disposed) return
      if (
        !playback ||
        !presentationId ||
        playback.id !== presentationId ||
        !Number.isSafeInteger(playback.version) ||
        playback.version < 1 ||
        !['ready', 'playing'].includes(playback.status)
      ) {
        stop()
        return
      }
      if (active?.id === playback.id && active.version === playback.version)
        return
      stop()
      if (
        playback.status !== 'ready' ||
        seen.has(key(playback.id, playback.version))
      )
        return
      seen.add(key(playback.id, playback.version))
      if (seen.size > 128) seen.delete(seen.values().next().value!)
      void start(playback.id, playback.version)
    },
    tick() {
      if (!active?.playing || !active.context || !active.samples) return
      const level = pcmLipLevel(
        active.samples,
        active.rate,
        active.context.currentTime - active.startedAt,
        active.volume,
      )
      deps.lip(level)
    },
    stop,
    dispose() {
      disposed = true
      stop()
    },
  }
}

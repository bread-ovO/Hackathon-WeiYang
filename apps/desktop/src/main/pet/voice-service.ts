import {
  parsePetVoicePreferences,
  parsePetVoicePcm,
  type PetVoicePreferences,
  type PetVoiceOption,
  type PetVoiceState,
  type PetVoiceAudio,
  type PetVoicePlayback,
  type PetVoicePcm,
} from '@memo/contracts'
interface Presentation {
  id: string
  kind: 'bubble' | 'action'
  text?: string
}
export interface PetVoiceServiceDeps {
  provider: {
    voices(signal: AbortSignal): Promise<PetVoiceOption[]>
    synthesize(input: {
      text: string
      voiceId: string
      rate: number
      signal: AbortSignal
    }): Promise<PetVoicePcm>
  }
  store: {
    load(): Promise<PetVoicePreferences | null>
    save(value: PetVoicePreferences): Promise<void>
  }
  current(): Presentation | null
  guard(): Promise<boolean>
  currentAllowed(): boolean
  notifyStop(): void
  activity(enabled: boolean): void
  now?: () => number
}
export function createPetVoiceService(deps: PetVoiceServiceDeps) {
  let preferences: PetVoicePreferences = {
    version: 1,
    enabled: false,
    voiceId: null,
    volume: 0.6,
    rate: 1,
  }
  let disposed = false,
    failed = false,
    configuring = 0,
    generation = 0,
    currentId: string | null = null,
    status: PetVoiceState['status'] = 'disabled',
    error: string | null = null
  let controller: AbortController | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    deadline = 0,
    audioData: PetVoiceAudio | null = null,
    taken = false
  let voices: PetVoiceOption[] | null = null,
    listing: Promise<void> | null = null,
    listController: AbortController | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const now = deps.now ?? Date.now,
    seen = new Set<string>()
  let lastActivity = false
  function serial<T>(fn: () => Promise<T>) {
    const p = queue.then(fn)
    queue = p.catch(() => undefined)
    return p
  }
  function notify() {
    const active = currentId !== null && !disposed
    if (active === lastActivity) return
    lastActivity = active
    try {
      deps.activity(active)
    } catch {
      /* no diagnostic crash */
    }
  }
  function invalidate() {
    generation++
    controller?.abort()
    controller = null
    audioData = null
    taken = false
    if (timer) clearTimeout(timer)
    timer = undefined
    try {
      deps.notifyStop()
    } catch {}
    currentId = null
    status = failed ? 'error' : preferences.enabled ? 'idle' : 'disabled'
    notify()
  }
  const ready = serial(async () => {
    try {
      const loaded = await deps.store.load()
      if (loaded) preferences = parsePetVoicePreferences(loaded)
      status = preferences.enabled ? 'idle' : 'disabled'
    } catch {
      failed = true
      status = 'error'
      error = 'PET_VOICE_STORAGE'
    }
  })
  function live(id: string, version: number) {
    return (
      !disposed &&
      !failed &&
      !configuring &&
      generation === version &&
      currentId === id &&
      deps.current()?.id === id &&
      deps.currentAllowed() &&
      now() <= deadline &&
      now() >= deadline - 12000
    )
  }
  async function allowed(id: string, version: number) {
    if (!live(id, version)) return false
    let okay = false
    try {
      okay = await deps.guard()
    } catch {}
    return okay && live(id, version)
  }
  function schedule(id: string, version: number) {
    if (!live(id, version)) {
      if (generation === version) invalidate()
      return
    }
    timer = setTimeout(
      () => {
        timer = undefined
        void allowed(id, version).then((okay) => {
          if (generation !== version) return
          if (!okay) invalidate()
          else schedule(id, version)
        })
      },
      Math.min(1000, Math.max(1, deadline - now())),
    )
  }
  async function list() {
    if (disposed) return
    if (voices !== null) return
    if (listing) return listing
    const own = new AbortController()
    listController = own
    listing = (async () => {
      try {
        const received = await deps.provider.voices(own.signal)
        if (disposed || own.signal.aborted) return
        if (
          !Array.isArray(received) ||
          received.length > 512 ||
          new Set(received.map((v) => v.id)).size !== received.length ||
          received.some(
            (v) =>
              !v ||
              Object.keys(v).sort().join(',') !== 'id,language,name' ||
              [v.id, v.name, v.language].some(
                (s) =>
                  typeof s !== 'string' ||
                  !s ||
                  s.length > 256 ||
                  /[\u0000-\u001f\u007f]/u.test(s),
              ),
          )
        )
          throw Error()
        voices = structuredClone(received)
      } catch {
        if (!disposed) {
          voices = []
          error = 'PET_VOICE_UNAVAILABLE'
          if (preferences.enabled) status = 'unavailable'
        }
      } finally {
        listing = null
        listController = null
      }
    })()
    return listing
  }
  async function state(): Promise<PetVoiceState> {
    await ready
    await list()
    return {
      preferences: structuredClone(preferences),
      voices: structuredClone(voices ?? []),
      available: !failed && (voices?.length ?? 0) > 0,
      status,
      error,
      currentId,
    }
  }
  async function begin(p: Presentation, ticket: number) {
    await ready
    if (
      ticket !== generation ||
      disposed ||
      configuring ||
      failed ||
      !preferences.enabled ||
      !preferences.voiceId ||
      deps.current()?.id !== p.id ||
      !deps.currentAllowed()
    )
      return
    const config = structuredClone(preferences),
      version = ++generation
    currentId = p.id
    deadline = now() + 12000
    status = 'synthesizing'
    error = null
    const own = new AbortController()
    controller = own
    notify()
    schedule(p.id, version)
    try {
      await list()
      if (!(await allowed(p.id, version))) return
      if (!voices?.some((v) => v.id === config.voiceId))
        throw Error('PET_VOICE_UNAVAILABLE')
      const pcm = parsePetVoicePcm(
        await deps.provider.synthesize({
          text: p.text!,
          voiceId: config.voiceId!,
          rate: config.rate,
          signal: own.signal,
        }),
      )
      if (!(await allowed(p.id, version))) return
      audioData = { id: p.id, version, pcm, volume: config.volume }
      status = 'ready'
      notify()
    } catch (cause) {
      if (generation === version && !own.signal.aborted) {
        const code = cause instanceof Error ? cause.message : ''
        error = [
          'PET_VOICE_TOO_LONG',
          'PET_VOICE_TIMEOUT',
          'PET_VOICE_INVALID_PCM',
          'PET_VOICE_UNAVAILABLE',
          'PET_VOICE_BUSY',
        ].includes(code)
          ? code
          : 'PET_VOICE_UNAVAILABLE'
        invalidate()
        status = 'error'
        notify()
      }
    } finally {
      if (controller === own) controller = null
      if (generation === version && status === 'synthesizing') invalidate()
    }
  }
  return {
    ready,
    state,
    stopNow() {
      invalidate()
    },
    async configure(
      expectedVersion: number,
      input: Omit<PetVoicePreferences, 'version'>,
    ) {
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        expectedVersion >= Number.MAX_SAFE_INTEGER
      )
        throw Error('PET_VOICE_INVALID')
      const config = parsePetVoicePreferences({
        ...structuredClone(input),
        version: expectedVersion + 1,
      })
      configuring++
      invalidate()
      try {
        await serial(async () => {
          if (disposed || failed) throw Error('PET_VOICE_STORAGE')
          if (preferences.version !== expectedVersion)
            throw Error('PET_VOICE_CONFLICT')
          if (config.enabled) {
            await list()
            if (!voices?.some((v) => v.id === config.voiceId))
              throw Error('PET_VOICE_UNAVAILABLE')
          }
          try {
            await deps.store.save(config)
          } catch {
            failed = true
            error = 'PET_VOICE_STORAGE'
            status = 'error'
            throw Error('PET_VOICE_STORAGE')
          }
          preferences = config
          error = null
          status = config.enabled ? 'idle' : 'disabled'
        })
      } finally {
        configuring--
        notify()
      }
      return state()
    },
    async stop() {
      invalidate()
      return state()
    },
    observe(p: Presentation | null) {
      if (disposed) return
      if (currentId && currentId !== p?.id) invalidate()
      if (
        !p ||
        p.kind !== 'bubble' ||
        typeof p.text !== 'string' ||
        !p.text.trim() ||
        Array.from(p.text).length > 240 ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(p.text) ||
        seen.has(p.id)
      )
        return
      if (seen.size >= 4096) seen.delete(seen.keys().next().value!)
      seen.add(p.id)
      void begin(structuredClone(p), generation)
    },
    playback(): PetVoicePlayback {
      return { id: currentId, version: generation, status }
    },
    async audio(input: {
      id: string
      version: number
    }): Promise<PetVoiceAudio | null> {
      const { id, version } = input
      if (
        taken ||
        !audioData ||
        audioData.id !== id ||
        audioData.version !== version ||
        status !== 'ready' ||
        !(await allowed(id, version))
      )
        return null
      if (taken || !audioData) return null
      taken = true
      return structuredClone(audioData)
    },
    report(input: {
      id: string
      version: number
      status: 'playing' | 'ended' | 'error'
    }) {
      if (!live(input.id, input.version)) return
      if (input.status === 'playing' && status === 'ready' && taken) {
        status = 'playing'
        audioData = null
        notify()
      } else if (input.status === 'ended' || input.status === 'error') {
        invalidate()
        if (input.status === 'error') {
          status = 'error'
          error = 'PET_VOICE_UNAVAILABLE'
        }
        notify()
      }
    },
    dispose() {
      disposed = true
      listController?.abort()
      invalidate()
    },
  }
}

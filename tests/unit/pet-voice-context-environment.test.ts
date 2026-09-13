import { describe, expect, it, vi } from 'vitest'
import { blocksPetPresentation } from '../../apps/desktop/src/main/pet/environment-block'
import { createPetContextService } from '../../apps/desktop/src/main/pet/context-service'
import { createPetVoiceService } from '../../apps/desktop/src/main/pet/voice-service'
import { createPresentationQueue } from '../../apps/desktop/src/main/pet/presentation-queue'
import type { PetContextFact } from '../../packages/contracts/src/pet-context-facts'

const normal = {
  locked: false,
  suspended: false,
  fullscreen: false,
  available: true,
}
const flush = async () => {
  for (let i = 0; i < 32; i++) await Promise.resolve()
}
async function fixture() {
  const queue = createPresentationQueue()
  queue.bind('synthetic-window')
  let monitoring = false,
    voice: ReturnType<typeof createPetVoiceService>
  const stops = vi.fn()
  const fact: PetContextFact = {
    projectId: 'p',
    taskId: 't',
    taskVersion: 1,
    criteriaVersion: 1,
    manualVersion: 1,
    title: '合成事项',
    status: 'todo',
    referenceId: 'manual:r',
    eventId: 1,
    proof: 'a'.repeat(64),
  }
  const context = createPetContextService({
    store: { load: async () => null, save: async () => {} },
    facts: async () => [fact],
    valid: async () => true,
    select: async () => ({ ref: 'r1', template: 'open' }),
    enqueue(text, reason) {
      if (
        !queue.enqueue(
          'synthetic-window',
          {
            kind: 'bubble',
            text,
            reference: { label: '查看相关事项', reason },
          },
          new Set(),
        )
      )
        return null
      voice.observe(queue.current())
      return queue.current()!.id
    },
    enqueueFallback: () => null,
    cancelPresentation(id) {
      queue.cancel(id)
      voice.observe(queue.current())
    },
    navigate: vi.fn(),
    isCurrent: (id) => queue.current()?.id === id,
    changed: vi.fn(),
  })
  function event(state: typeof normal) {
    if (blocksPetPresentation(state, monitoring)) {
      voice.stopNow()
      context.invalidateDisplay()
    }
  }
  voice = createPetVoiceService({
    store: {
      load: async () => ({
        version: 1,
        enabled: true,
        voiceId: 'synthetic',
        volume: 0.6,
        rate: 1,
      }),
      save: async () => {},
    },
    provider: {
      voices: async () => [
        { id: 'synthetic', name: '合成测试音色', language: 'zh-CN' },
      ],
      synthesize: async () => ({
        sampleRate: 8000,
        channels: 1,
        format: 'f32le',
        frames: 1,
        data: 'AAAAAA==',
      }),
    },
    current: () => queue.current(),
    guard: async () => true,
    currentAllowed: () => true,
    notifyStop: stops,
    activity(enabled) {
      if (monitoring === enabled) return
      // Match main: publish ownership BEFORE the adapter's synchronous notification.
      monitoring = enabled
      event({ ...normal, available: enabled })
    },
  })
  await context.ready
  await voice.ready
  await context.configure(1, {
    enabled: true,
    projectIds: ['p'],
    useModel: false,
    model: '',
  })
  const preview = await context.preview()
  await context.show(preview.id)
  await flush()
  return {
    context,
    voice,
    queue,
    event,
    stops,
    get monitoring() {
      return monitoring
    },
    dispose() {
      voice.dispose()
      context.dispose()
    },
  }
}

describe('voice monitor and referenced text lifecycle', () => {
  it('ready observation and normal audio end do not remove the referenced text', async () => {
    const f = await fixture()
    try {
      expect(f.monitoring).toBe(true)
      expect(f.voice.playback().status).toBe('ready')
      const original = f.queue.current()!
      expect(original.reference).toBeDefined()
      f.event(normal)
      expect(f.queue.current()?.id).toBe(original.id)
      const version = f.voice.playback().version
      expect(await f.voice.audio({ id: original.id, version })).not.toBeNull()
      f.voice.report({ id: original.id, version, status: 'playing' })
      f.voice.report({ id: original.id, version, status: 'ended' })
      // setEnabled(false) publishes unavailable, but this is not a failed probe.
      expect(f.monitoring).toBe(false)
      expect(f.voice.playback().id).toBeNull()
      expect(f.queue.current()).toEqual(original)
      expect(await f.context.open(original.id)).toBe(true)
    } finally {
      f.dispose()
    }
  })
  it.each(['locked', 'suspended', 'fullscreen', 'unavailable'] as const)(
    'a real %s observation cancels synthesis and the referenced bubble',
    async (reason) => {
      const f = await fixture()
      try {
        f.event({
          ...normal,
          ...(reason === 'unavailable'
            ? { available: false }
            : { [reason]: true }),
        })
        expect(f.queue.current()).toBeNull()
        expect(f.voice.playback().id).toBeNull()
        expect(f.monitoring).toBe(false)
        expect(f.stops).toHaveBeenCalled()
      } finally {
        f.dispose()
      }
    },
  )
  it.each(['locked', 'suspended'] as const)(
    'power %s still clears a referenced bubble after monitoring has stopped',
    async (reason) => {
      const f = await fixture()
      try {
        f.voice.stopNow()
        expect(f.monitoring).toBe(false)
        expect(f.queue.current()).not.toBeNull()
        f.event({ ...normal, [reason]: true })
        expect(f.queue.current()).toBeNull()
      } finally {
        f.dispose()
      }
    },
  )
})

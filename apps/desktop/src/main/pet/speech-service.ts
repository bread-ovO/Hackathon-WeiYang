import {
  createPetSpeechState,
  configurePetSpeech,
  tickPetSpeech,
  isPetSpeechQuiet,
  PET_SPEECH_RESUME_GAP_MS,
  type PetSpeechState as PolicyState,
  type PetSpeechClock,
} from '@memo/domain'
import type { PetSpeechPatch, PetSpeechState } from '@memo/contracts'

interface Environment {
  locked: boolean
  suspended: boolean
  fullscreen: boolean
  available: boolean
}
export interface PetSpeechServiceDeps {
  store: {
    load(): Promise<PolicyState | null>
    save(state: PolicyState): Promise<void>
  }
  environment(): Promise<Environment>
  display(): { visible: boolean; busy: boolean }
  deliver(text: string): string | null
  cancel(id: string): void
  monitor?(enabled: boolean): void
  clock?: PetSpeechClock
  schedule?: (callback: () => void) => () => void
}
/** Serial durable reservations precede presentation. Cancellation fences async work. */
export function createPetSpeechService(deps: PetSpeechServiceDeps) {
  const clock = deps.clock ?? {
    now: () => Date.now(),
    random: () => Math.random(),
  }
  let policy = createPetSpeechState(clock)
  let status: PetSpeechState['status'] = 'disabled'
  let revision = 0,
    disposed = false,
    failed = false,
    active: string | null = null
  let cancelTimer: (() => void) | undefined
  let serial: Promise<unknown> = Promise.resolve()
  function cancelActive() {
    if (active) deps.cancel(active)
    active = null
  }
  function invalidate() {
    revision++
    cancelTimer?.()
    cancelTimer = undefined
    cancelActive()
  }
  function snapshot(): PetSpeechState {
    return {
      preferences: { ...policy.preferences },
      nextAt: policy.nextAt,
      todayCount: policy.count,
      status,
    }
  }
  function schedule() {
    cancelTimer?.()
    cancelTimer = undefined
    const enabled =
      !disposed &&
      !failed &&
      policy.preferences.enabled &&
      deps.display().visible
    deps.monitor?.(enabled)
    if (!enabled) return
    const create =
      deps.schedule ??
      ((callback: () => void) => {
        const timer = setTimeout(callback, 15000)
        timer.unref()
        return () => clearTimeout(timer)
      })
    cancelTimer = create(() => {
      cancelTimer = undefined
      void enqueue(() => tick(false))
    })
  }
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(operation)
    serial = result.catch(() => undefined)
    return result
  }
  async function tick(resumed: boolean) {
    if (disposed || failed) return
    const ticket = revision
    try {
      const environment =
        policy.preferences.enabled && deps.display().visible
          ? await deps.environment()
          : {
              locked: false,
              suspended: false,
              fullscreen: false,
              available: true,
            }
      if (disposed || ticket !== revision) return
      const display = deps.display()
      const decision = tickPetSpeech(
        policy,
        {
          locked: environment.locked || !environment.available,
          asleep: environment.suspended,
          fullscreen: environment.fullscreen,
          ...display,
          resumed,
        },
        clock,
      )
      if (
        ['disabled', 'paused', 'quiet'].includes(decision.reason) ||
        !display.visible ||
        !environment.available ||
        environment.locked ||
        environment.suspended ||
        environment.fullscreen
      )
        cancelActive()
      await deps.store.save(decision.state)
      policy = decision.state
      status = ['disabled', 'paused', 'quiet', 'suppressed'].includes(
        decision.reason,
      )
        ? (decision.reason as PetSpeechState['status'])
        : 'waiting'
      if (decision.speech && ticket === revision && !disposed) {
        const latest = await deps.environment()
        const visible = deps.display()
        const now = clock.now(),
          local = clock.localTime?.(now)
        const date = new Date(now),
          minute = local?.minute ?? date.getHours() * 60 + date.getMinutes()
        const timely =
          now >= decision.state.lastNow &&
          now - decision.state.lastNow <= PET_SPEECH_RESUME_GAP_MS &&
          !isPetSpeechQuiet(
            minute,
            policy.preferences.quietStart,
            policy.preferences.quietEnd,
          ) &&
          (policy.preferences.pausedUntil === null ||
            now >= policy.preferences.pausedUntil)
        if (
          timely &&
          ticket === revision &&
          !disposed &&
          latest.available &&
          !latest.locked &&
          !latest.suspended &&
          !latest.fullscreen &&
          visible.visible &&
          !visible.busy
        )
          active = deps.deliver(decision.speech.text)
      }
    } catch {
      failed = true
      status = 'error'
      cancelActive()
    } finally {
      schedule()
    }
  }
  const ready = enqueue(async () => {
    try {
      policy = (await deps.store.load()) ?? policy
    } catch {
      failed = true
      status = 'error'
      return
    }
    await tick(true)
  })
  return {
    ready,
    snapshot,
    wake() {
      invalidate()
      if (failed || !deps.display().visible || !policy.preferences.enabled)
        deps.monitor?.(false)
      return enqueue(() => tick(true))
    },
    async configure(input: PetSpeechPatch): Promise<boolean> {
      let patch: PetSpeechPatch
      try {
        patch = structuredClone(input)
        configurePetSpeech(policy, patch, clock)
      } catch {
        return false
      }
      // Reject out-of-range pause requests even if called outside the IPC parser.
      if (
        patch.pausedUntil !== undefined &&
        patch.pausedUntil !== null &&
        (patch.pausedUntil < clock.now() ||
          patch.pausedUntil > clock.now() + 24 * 60 * 60_000)
      )
        return false
      invalidate()
      return enqueue(async () => {
        if (disposed || failed) return false
        try {
          const next = configurePetSpeech(policy, patch, clock)
          await deps.store.save(next)
          policy = next
          await tick(true)
          return !failed
        } catch {
          failed = true
          status = 'error'
          cancelActive()
          deps.monitor?.(false)
          return false
        }
      })
    },
    dispose() {
      disposed = true
      invalidate()
      deps.monitor?.(false)
    },
  }
}

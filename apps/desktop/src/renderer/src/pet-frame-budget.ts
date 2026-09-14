/** Preserve fractional frame time instead of resetting it after every draw. */
export function createPetFrameBudget() {
  let last: number | undefined,
    credit = 0
  return {
    reset() {
      last = undefined
      credit = 0
    },
    due(now: number, fps: 30 | 60): boolean {
      if (!Number.isFinite(now)) return false
      const interval = 1000 / fps
      if (last === undefined || now < last) {
        last = now
        credit = 0
        return true
      }
      credit += Math.min(now - last, 250)
      last = now
      if (credit + 1e-6 < interval) return false
      credit = Math.max(0, credit - interval) % interval
      return true
    },
  }
}
export function petTargetFps(
  now: number,
  lastInteraction: number,
  active: boolean,
  smooth = false,
): 30 | 60 {
  return smooth ||
    active ||
    (now >= lastInteraction && now - lastInteraction < 4000)
    ? 60
    : 30
}
/** Recovery is bounded per renderer, independent of model changes or async outcomes. */
export function createPetRecoveryBudget() {
  let attempts: number[] = []
  return {
    take(now: number): boolean {
      if (!Number.isFinite(now)) return false
      attempts = attempts.filter((at) => now >= at && now - at < 60000)
      if (attempts.length >= 2) return false
      attempts.push(now)
      return true
    },
  }
}

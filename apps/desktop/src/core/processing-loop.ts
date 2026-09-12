export interface ProcessingLoopDependencies {
  isEnabled(): boolean
  /** One synchronous, lease-fenced local transaction. Returns false when idle. */
  runOne(): boolean
  onError(): void
}

/** Small batches yield to core IPC. No cloud provider or unbounded work runs here. */
export function createProcessingLoop(deps: ProcessingLoopDependencies) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let failures = 0
  const schedule = (delay: number) => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(tick, delay)
  }
  function tick() {
    timer = undefined
    if (disposed) return
    let delay = 1000
    try {
      if (!deps.isEnabled()) return
      let count = 0
      while (count < 4 && !disposed && deps.isEnabled() && deps.runOne())
        count++
      failures = 0
      if (count === 4) delay = 50
    } catch {
      failures = Math.min(failures + 1, 6)
      delay = Math.min(30_000, 1000 * 2 ** (failures - 1))
      try {
        deps.onError()
      } catch {
        /* diagnostics must not crash the core */
      }
    } finally {
      schedule(delay)
    }
  }
  return {
    start() {
      schedule(0)
    },
    wake() {
      if (disposed) return
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      schedule(0)
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

import {
  parseProposal,
  type Lease,
  type SourceEventV2,
  type DecisionProposal,
  type OperationResult,
} from '@memo/contracts/foundation'

export interface JobStore {
  claimJob(
    owner: string,
    pipelines: readonly string[],
    leaseMs: number,
  ): Lease | null
  renewLease(lease: Lease, leaseMs: number): number
  failJob(
    lease: Lease,
    code: string,
    kind: 'retry' | 'dead' | 'paused' | 'cancelled',
    delayMs?: number,
  ): void
  saveProposal(lease: Lease, input: unknown): void
  commitJob(lease: Lease, input: unknown): OperationResult
  job(id: number): { proposal: DecisionProposal | null }
  jobInput(lease: Lease): {
    event: SourceEventV2
    reference: { eventId: number; generation: number; scopeEpoch: number }
  }
}
export type JobHandler = (
  input: ReturnType<JobStore['jobInput']> & {
    signal: AbortSignal
    lease: Lease
  },
) => Promise<unknown>
export class JobFailure extends Error {
  constructor(
    readonly code: string,
    readonly kind: 'retry' | 'dead' | 'paused' | 'cancelled' = 'retry',
  ) {
    super(code)
  }
}
export interface RunnerOptions {
  owner: string
  leaseMs?: number
  timeoutMs?: number
  concurrency?: number
  baseDelayMs?: number
  maxDelayMs?: number
  random?: () => number
  now?: () => number
  onError?: (code: string) => void
}
export class JobRunner {
  private timer: ReturnType<typeof setInterval> | undefined
  private active = new Set<Promise<void>>()
  private controllers = new Set<AbortController>()
  private stopped = false
  private readonly leaseMs: number
  private readonly timeoutMs: number
  private readonly random: () => number
  private readonly now: () => number
  constructor(
    private store: JobStore,
    private handlers: ReadonlyMap<string, JobHandler>,
    private options: RunnerOptions,
  ) {
    this.leaseMs = options.leaseMs ?? 60000
    this.timeoutMs = options.timeoutMs ?? 120000
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
    if (
      this.leaseMs < 30 ||
      this.timeoutMs < 1 ||
      (options.concurrency ?? 2) < 1 ||
      (options.concurrency ?? 2) > 16
    )
      throw new Error('INVALID_RUNNER_OPTIONS')
  }
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => this.tick(), 250)
    this.tick()
  }
  private tick(): void {
    if (this.stopped) return
    while (this.active.size < (this.options.concurrency ?? 2)) {
      let lease: Lease | null
      try {
        lease = this.store.claimJob(
          this.options.owner,
          [...this.handlers.keys()],
          this.leaseMs,
        )
      } catch (error) {
        this.options.onError?.(
          error instanceof Error ? error.message : 'STORAGE_ERROR',
        )
        break
      }
      if (!lease) break
      const promise = this.execute(lease).finally(() =>
        this.active.delete(promise),
      )
      this.active.add(promise)
    }
  }
  async runOnce(): Promise<boolean> {
    const lease = this.store.claimJob(
      this.options.owner,
      [...this.handlers.keys()],
      this.leaseMs,
    )
    if (!lease) return false
    await this.execute(lease)
    return true
  }
  private async execute(lease: Lease): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    let last = this.now()
    const checkClock = () => {
      const now = this.now()
      if (now < last) throw new JobFailure('CLOCK_CHANGED', 'paused')
      last = now
    }
    const heartbeat = setInterval(
      () => {
        try {
          checkClock()
          this.store.renewLease(lease, this.leaseMs)
        } catch (error) {
          controller.abort(
            error instanceof JobFailure
              ? error
              : new JobFailure('STALE_LEASE', 'cancelled'),
          )
        }
      },
      Math.max(10, Math.floor(this.leaseMs / 3)),
    )
    const timeout = setTimeout(
      () => controller.abort(new JobFailure('HANDLER_TIMEOUT')),
      this.timeoutMs,
    )
    let detach = () => {}
    try {
      const aborted = new Promise<never>((_, reject) => {
        const onAbort = () =>
          reject(
            controller.signal.reason ??
              new JobFailure('CANCELLED', 'cancelled'),
          )
        controller.signal.addEventListener('abort', onAbort, { once: true })
        detach = () => controller.signal.removeEventListener('abort', onAbort)
      })
      const saved = this.store.job(lease.id).proposal
      const input = this.store.jobInput(lease)
      const output =
        saved ??
        (await Promise.race([
          this.handlers.get(lease.pipelineVersion)!({
            ...input,
            signal: controller.signal,
            lease,
          }),
          aborted,
        ]))
      if (controller.signal.aborted) throw controller.signal.reason
      checkClock()
      const proposal = parseProposal(output)
      this.store.saveProposal(lease, proposal)
      this.store.commitJob(lease, proposal)
    } catch (error) {
      const known = error instanceof JobFailure ? error : undefined
      const message = error instanceof Error ? error.message : ''
      const conflicts = [
        'VERSION_CONFLICT',
        'STALE_EVIDENCE',
        'STALE_MAPPING',
        'STALE_PLAN',
      ]
      const permanent = [
        'MANUAL_OVERRIDE',
        'INVALID_PROPOSAL',
        'INVALID_PROPOSAL_ORIGIN',
        'MISSING_INPUT_REF',
        'SCOPE_DENIED',
        'UNKNOWN_TASK',
        'TASK_EXISTS',
        'COMPLETION_NOT_SUPPORTED',
        'AUTOMATIC_CANCEL_DISABLED',
        'INVALID_PLAN_ORIGIN',
      ]
      const paused = [
        'DISK_LIMIT',
        'DISK_UNAVAILABLE',
        'SOURCE_PAUSED',
        'CLOCK_CHANGED',
      ]
      const code =
        known?.code ??
        (conflicts.includes(message) ||
        permanent.includes(message) ||
        paused.includes(message)
          ? message
          : 'HANDLER_FAILED')
      const kind =
        known?.kind ??
        (permanent.includes(message)
          ? 'dead'
          : paused.includes(message)
            ? 'paused'
            : 'retry')
      const base = this.options.baseDelayMs ?? 1000,
        max = this.options.maxDelayMs ?? 60000
      const delay = Math.floor(
        Math.min(max, base * 2 ** Math.min(lease.attempt - 1, 20)) *
          (0.5 + Math.max(0, Math.min(1, this.random())) * 0.5),
      )
      try {
        this.store.failJob(lease, code, kind, delay)
      } catch {
        /* A newer lease or revoked grant owns settlement; do not bypass it. */
      }
      this.options.onError?.(code)
    } finally {
      clearInterval(heartbeat)
      clearTimeout(timeout)
      detach()
      this.controllers.delete(controller)
    }
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const c of this.controllers)
      c.abort(new JobFailure('RUNNER_STOPPED', 'retry'))
    await Promise.allSettled([...this.active])
  }
}

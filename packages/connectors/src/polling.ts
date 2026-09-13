import type { FeishuMessagePage, FeishuPageFetcher } from './feishu'
export interface PollResult {
  nextCursor: string
  inserted: number
}
export interface PollDiagnostics {
  pullAttempts: number
  failedPulls: number
  committedPages: number
  insertedRecords: number
  consecutiveFailures: number
  nextRetryAt: number | null
  lastSuccessAt: number | null
}
/** The sink must atomically persist the page and cursor, fenced by its authorization version.
 * Its optional signal permits a final cancellation check before starting that transaction.
 * A sink rejection is not retried here: callers must recover their durable cursor first.
 */
export class SourcePoller {
  private running = false
  private lastClock = 0
  private readonly diagnostics: PollDiagnostics = {
    pullAttempts: 0,
    failedPulls: 0,
    committedPages: 0,
    insertedRecords: 0,
    consecutiveFailures: 0,
    nextRetryAt: null,
    lastSuccessAt: null,
  }
  constructor(
    private readonly pullPage: FeishuPageFetcher,
    private readonly onPage: (
      page: FeishuMessagePage,
      nextCursor: string,
      signal?: AbortSignal,
    ) => Promise<number>,
    private readonly baseDelayMs = 1000,
    private readonly maxDelayMs = 60000,
    private readonly maxFailures = 3,
    private readonly maxPages = 100,
    private readonly now: () => number = Date.now,
  ) {
    if (
      !Number.isSafeInteger(maxFailures) ||
      maxFailures < 1 ||
      maxFailures > 20
    )
      throw new Error('INVALID_POLL_FAILURE_LIMIT')
    if (
      !Number.isSafeInteger(baseDelayMs) ||
      baseDelayMs < 0 ||
      !Number.isSafeInteger(maxDelayMs) ||
      maxDelayMs < baseDelayMs ||
      maxDelayMs > 60000
    )
      throw new Error('INVALID_POLL_DELAY')
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000)
      throw new Error('INVALID_POLL_PAGE_LIMIT')
  }
  getDiagnostics(): PollDiagnostics {
    return { ...this.diagnostics }
  }
  private time(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('INVALID_POLL_CLOCK')
    this.lastClock = Math.max(this.lastClock, value)
    return this.lastClock
  }
  async run(cursor: string, signal: AbortSignal): Promise<string> {
    if (this.running) throw new Error('POLL_ALREADY_RUNNING')
    if (!this.validCursor(cursor)) throw new Error('INVALID_PAGE_CURSOR')
    this.running = true
    let current = cursor
    let delay = this.baseDelayMs
    let failures = 0
    let pages = 0
    const seen = new Set([cursor])
    this.diagnostics.consecutiveFailures = 0
    try {
      while (!signal.aborted && pages < this.maxPages) {
        let page: FeishuMessagePage
        try {
          this.time()
          this.diagnostics.pullAttempts++
          page = await this.pullPage(current, signal)
        } catch (error) {
          if (
            signal.aborted ||
            (error instanceof Error && error.name === 'AbortError')
          )
            return current
          failures++
          this.diagnostics.failedPulls++
          this.diagnostics.consecutiveFailures = failures
          if (failures >= this.maxFailures) throw error
          let retryDelay = delay
          if (error && typeof error === 'object' && 'retryAfterMs' in error) {
            const serverDelay = error.retryAfterMs
            if (
              typeof serverDelay !== 'number' ||
              !Number.isFinite(serverDelay) ||
              serverDelay < 0 ||
              serverDelay > 86400000
            )
              throw new Error('INVALID_POLL_RETRY_DELAY')
            retryDelay = Math.max(delay, Math.ceil(serverDelay))
          }
          this.diagnostics.nextRetryAt = this.time() + retryDelay
          await this.wait(retryDelay, signal)
          this.diagnostics.nextRetryAt = null
          delay = Math.min(
            this.maxDelayMs,
            Math.max(this.baseDelayMs, delay * 2),
          )
          continue
        }
        // A transport may finish successfully after cancellation. Never hand that page to a sink.
        if (signal.aborted) return current
        if (
          !page ||
          typeof page !== 'object' ||
          !Array.isArray(page.items) ||
          (page.hasMore !== undefined && typeof page.hasMore !== 'boolean') ||
          (page.pageToken !== undefined && !this.validCursor(page.pageToken)) ||
          (page.hasMore === true && !page.pageToken)
        )
          throw new Error('INVALID_PAGE_CURSOR')
        const next = page.hasMore === false ? '' : (page.pageToken ?? '')
        if (next && seen.has(next)) throw new Error('POLL_CURSOR_LOOP')
        // Intentionally outside the pull retry catch. A failed/ambiguous commit must not
        // re-fetch a moving page, and a successful in-flight commit survives cancellation.
        const inserted = await this.onPage(page, next, signal)
        current = next
        pages++
        this.diagnostics.committedPages++
        this.diagnostics.lastSuccessAt = this.time()
        if (
          !Number.isSafeInteger(inserted) ||
          inserted < 0 ||
          inserted > page.items.length
        )
          throw new Error('INVALID_POLL_SINK_RESULT')
        this.diagnostics.insertedRecords += inserted
        failures = 0
        this.diagnostics.consecutiveFailures = 0
        delay = this.baseDelayMs
        if (!current || signal.aborted || pages === this.maxPages)
          return current
        seen.add(current)
        await this.wait(delay, signal)
      }
      return current
    } finally {
      this.running = false
      this.diagnostics.nextRetryAt = null
    }
  }
  private validCursor(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length <= 2048 &&
      !/[\u0000-\u001f\u007f]/.test(value)
    )
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }
}

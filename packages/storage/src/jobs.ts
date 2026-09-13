import type Database from 'better-sqlite3'

export const MAX_JOB_ATTEMPTS = 3
export const JOB_LEASE_MS = 30_000
export type JobErrorCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'INVALID_OUTPUT'
  | 'EXECUTION_FAILED'
  | 'LEASE_EXPIRED'
export interface Job {
  id: number
  eventId: number
  state: 'pending' | 'running' | 'done' | 'failed'
  attempt: number
  leaseUntil: string | null
  nextRun: string | null
  errorCode: JobErrorCode | null
}
// Each successful claim increments attempt. The pair fences all earlier workers.
export type JobLease = Pick<Job, 'id' | 'attempt'>
const columns =
  'id, event_id AS eventId, state, attempt, lease_until AS leaseUntil, next_run AS nextRun, error_code AS errorCode'
const errors: readonly JobErrorCode[] = [
  'TIMEOUT',
  'RATE_LIMITED',
  'INVALID_OUTPUT',
  'EXECUTION_FAILED',
  'LEASE_EXPIRED',
]
function timestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error('INVALID_JOB_TIME')
  return now.toISOString()
}
function checkLease(lease: JobLease): void {
  if (
    !Number.isSafeInteger(lease.id) ||
    lease.id < 1 ||
    !Number.isSafeInteger(lease.attempt) ||
    lease.attempt < 1
  )
    throw new Error('INVALID_JOB_LEASE')
}

/** Durable queue primitives; callers must make external side effects idempotent. */
export function createJobQueue(db: Database.Database) {
  const claim = db.transaction((now: Date): Job | undefined => {
    const at = timestamp(now)
    // Exhausted crashed workers are terminal too, not just explicit failures.
    db.prepare(
      `UPDATE jobs SET state='failed', lease_until=NULL, next_run=NULL,
      error_code='LEASE_EXPIRED' WHERE state='running' AND (lease_until IS NULL OR lease_until<=?) AND attempt>=?`,
    ).run(at, MAX_JOB_ATTEMPTS)
    const candidate = db
      .prepare(
        `SELECT id FROM jobs
      WHERE attempt<? AND ((state='pending' AND (next_run IS NULL OR next_run<=?))
        OR (state='running' AND (lease_until IS NULL OR lease_until<=?)))
      ORDER BY COALESCE(next_run, ''), id LIMIT 1`,
      )
      .get(MAX_JOB_ATTEMPTS, at, at) as { id: number } | undefined
    if (!candidate) return undefined
    db.prepare(
      `UPDATE jobs SET state='running', attempt=attempt+1,
      error_code=CASE WHEN state='running' THEN 'LEASE_EXPIRED' ELSE error_code END,
      lease_until=?, next_run=NULL WHERE id=?`,
    ).run(new Date(now.getTime() + JOB_LEASE_MS).toISOString(), candidate.id)
    return db
      .prepare(`SELECT ${columns} FROM jobs WHERE id=?`)
      .get(candidate.id) as Job
  })
  return {
    // BEGIN IMMEDIATE serializes the read/update across SQLite connections.
    claim(now = new Date()): Job | undefined {
      return claim.immediate(now)
    },
    renew(lease: JobLease, now = new Date()): boolean {
      checkLease(lease)
      const at = timestamp(now)
      return (
        db
          .prepare(
            `UPDATE jobs SET lease_until=MAX(lease_until, ?) WHERE id=? AND attempt=?
        AND state='running' AND lease_until>?`,
          )
          .run(
            new Date(now.getTime() + JOB_LEASE_MS).toISOString(),
            lease.id,
            lease.attempt,
            at,
          ).changes === 1
      )
    },
    complete(lease: JobLease, now = new Date()): boolean {
      checkLease(lease)
      return (
        db
          .prepare(
            `UPDATE jobs SET state='done', lease_until=NULL, next_run=NULL, error_code=NULL
        WHERE id=? AND attempt=? AND state='running' AND lease_until>?`,
          )
          .run(lease.id, lease.attempt, timestamp(now)).changes === 1
      )
    },
    fail(
      lease: JobLease,
      code: JobErrorCode,
      retryable: boolean,
      now = new Date(),
    ): boolean {
      checkLease(lease)
      if (!errors.includes(code) || typeof retryable !== 'boolean')
        throw new Error('INVALID_JOB_FAILURE')
      const at = timestamp(now)
      const retry = retryable && lease.attempt < MAX_JOB_ATTEMPTS
      const nextRun = retry
        ? new Date(
            now.getTime() + Math.min(60_000, 1000 * 2 ** (lease.attempt - 1)),
          ).toISOString()
        : null
      return (
        db
          .prepare(
            `UPDATE jobs SET state=?, lease_until=NULL, next_run=?, error_code=?
        WHERE id=? AND attempt=? AND state='running' AND lease_until>?`,
          )
          .run(
            retry ? 'pending' : 'failed',
            nextRun,
            code,
            lease.id,
            lease.attempt,
            at,
          ).changes === 1
      )
    },
    get(id: number): Job | undefined {
      if (!Number.isSafeInteger(id) || id < 1) throw new Error('INVALID_JOB_ID')
      return db.prepare(`SELECT ${columns} FROM jobs WHERE id=?`).get(id) as
        | Job
        | undefined
    },
  }
}

import {
  parseProposal,
  type Lease,
  type OperationResult,
  type SourceEventV2,
} from '@memo/contracts/foundation'
import { type Context, iso } from './context'
import { authorized } from './ingestion'
import { applyOperation, validateInputs } from './tasks'
import { bytes, requireId } from './util'

interface Job {
  id: number
  event_id: number
  operation_id: string
  state: string
  attempt: number
  max_attempts: number
  lease_owner: string | null
  lease_token: number
  lease_until: number | null
  scope_epoch: number
  pipeline_version: string
  source_id: string
  scope_id: string
  proposal: string | null
}
export function jobRow(ctx: Context, id: number): Job {
  const row = ctx.db
    .prepare(
      'SELECT j.*,e.source_id,e.scope_id FROM jobs j JOIN source_events e ON e.id=j.event_id WHERE j.id=?',
    )
    .get(id) as Job | undefined
  if (!row) throw new Error('UNKNOWN_JOB')
  return row
}
function assertLease(
  ctx: Context,
  lease: Lease,
  allowClockRollback = false,
): Job {
  const row = jobRow(ctx, lease.id)
  if (
    row.state !== 'running' ||
    row.lease_owner !== lease.owner ||
    row.lease_token !== lease.token ||
    row.lease_until === null ||
    row.lease_until <= ctx.now() ||
    row.operation_id !== lease.operationId
  )
    throw new Error('STALE_LEASE')
  const attempt = ctx.db
    .prepare('SELECT started_at FROM job_attempts WHERE job_id=? AND token=?')
    .get(row.id, row.lease_token) as { started_at: number } | undefined
  if (!allowClockRollback && attempt && ctx.now() < attempt.started_at)
    throw new Error('CLOCK_CHANGED')
  const s = authorized(ctx, row.source_id, row.scope_id, row.scope_epoch)
  if (s.pause_code) throw new Error('SOURCE_PAUSED')
  return row
}
export function jobRepository(ctx: Context) {
  const { db } = ctx
  function claimJob(
    owner: string,
    pipelines: readonly string[] = ['v1'],
    leaseMs = 60000,
  ): Lease | null {
    requireId(owner)
    if (
      !Number.isInteger(leaseMs) ||
      leaseMs < 1 ||
      leaseMs > 3600000 ||
      pipelines.length > 32
    )
      throw new Error('INVALID_LEASE')
    if (!pipelines.length) return null
    pipelines.forEach(requireId)
    return db
      .transaction(() => {
        ctx.guard()
        db.prepare(
          "UPDATE jobs SET state='dead',error_code='ATTEMPTS_EXHAUSTED',finished_at=? WHERE attempt>=max_attempts AND ((state='running' AND lease_until<=?) OR state IN ('pending','retry_wait') OR (state='paused' AND error_code IN ('DISK_LIMIT','DISK_UNAVAILABLE','SOURCE_PAUSED')))",
        ).run(iso(ctx), ctx.now())
        const row = db
          .prepare(
            `SELECT j.*,e.source_id,e.scope_id FROM jobs j JOIN source_events e ON e.id=j.event_id JOIN source_instances s ON s.id=e.source_id
        WHERE (((j.state IN ('pending','retry_wait') OR (j.state='paused' AND j.error_code IN ('DISK_LIMIT','DISK_UNAVAILABLE','SOURCE_PAUSED'))) AND j.next_run<=?) OR (j.state='running' AND j.lease_until<=?))
        AND j.attempt<j.max_attempts AND s.active=1 AND s.scope_epoch=j.scope_epoch AND s.pause_code IS NULL
        AND EXISTS(SELECT 1 FROM json_each(s.scopes) WHERE value=e.scope_id)
        AND j.pipeline_version IN (${pipelines.map(() => '?').join(',')}) ORDER BY j.next_run,j.id LIMIT 1`,
          )
          .get(ctx.now(), ctx.now(), ...pipelines) as Job | undefined
        if (!row) return null
        const token = row.lease_token + 1,
          until = ctx.now() + leaseMs
        db.prepare(
          "UPDATE jobs SET state='running',lease_owner=?,lease_token=?,lease_until=?,attempt=attempt+1 WHERE id=?",
        ).run(owner, token, until, row.id)
        db.prepare(
          "UPDATE job_attempts SET outcome='LEASE_EXPIRED' WHERE job_id=? AND outcome IS NULL",
        ).run(row.id)
        db.prepare(
          'INSERT INTO job_attempts(job_id,token,owner,started_at) VALUES(?,?,?,?)',
        ).run(row.id, token, owner, ctx.now())
        ctx.fault('job:claimed')
        return {
          id: row.id,
          eventId: row.event_id,
          operationId: row.operation_id,
          owner,
          token,
          until,
          sourceId: row.source_id,
          scopeEpoch: row.scope_epoch,
          attempt: row.attempt + 1,
          pipelineVersion: row.pipeline_version,
        }
      })
      .immediate()
  }
  function renewLease(lease: Lease, leaseMs = 60000): number {
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3600000)
      throw new Error('INVALID_LEASE')
    return db
      .transaction(() => {
        assertLease(ctx, lease)
        ctx.guard()
        const until = ctx.now() + leaseMs
        db.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(
          until,
          lease.id,
        )
        return until
      })
      .immediate()
  }
  function failJob(
    lease: Lease,
    code: string,
    kind: 'retry' | 'dead' | 'paused' | 'cancelled',
    delayMs = 0,
  ): void {
    if (
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ||
      !Number.isInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 86400000
    )
      throw new Error('INVALID_JOB_ERROR')
    db.transaction(() => {
      // A current fenced owner may record clock failure, but may not write business results.
      const row = assertLease(
        ctx,
        lease,
        code === 'CLOCK_CHANGED' && kind === 'paused',
      )
      const state =
        kind === 'retry'
          ? row.attempt >= row.max_attempts
            ? 'dead'
            : 'retry_wait'
          : kind
      db.prepare(
        'UPDATE jobs SET state=?,next_run=?,error_code=?,lease_until=NULL,proposal=NULL,finished_at=? WHERE id=?',
      ).run(
        state,
        ctx.now() + delayMs,
        code,
        ['dead', 'cancelled'].includes(state) ? iso(ctx) : null,
        lease.id,
      )
      db.prepare(
        'UPDATE job_attempts SET outcome=? WHERE job_id=? AND token=?',
      ).run(code, lease.id, lease.token)
      ctx.fault('job:failed')
    }).immediate()
  }
  function checkProposal(lease: Lease, input: unknown) {
    const p = parseProposal(input)
    if (
      p.policyVersion !== lease.pipelineVersion ||
      !p.inputs.some(
        (ref) =>
          ref.eventId === lease.eventId && ref.scopeEpoch === lease.scopeEpoch,
      )
    )
      throw new Error('INVALID_PROPOSAL_ORIGIN')
    validateInputs(ctx, p)
    return p
  }
  function saveProposal(lease: Lease, input: unknown): void {
    db.transaction(() => {
      assertLease(ctx, lease)
      const p = checkProposal(lease, input)
      ctx.guard(bytes(p))
      db.prepare('UPDATE jobs SET proposal=? WHERE id=?').run(
        JSON.stringify(p),
        lease.id,
      )
    }).immediate()
  }
  function commitJob(lease: Lease, input: unknown): OperationResult {
    const result = db
      .transaction(() => {
        const row = jobRow(ctx, lease.id)
        if (
          row.state === 'done' &&
          row.lease_owner === lease.owner &&
          row.lease_token === lease.token &&
          row.operation_id === lease.operationId
        )
          return applyOperation(ctx, row.operation_id, input, 'automatic')
        assertLease(ctx, lease)
        const p = checkProposal(lease, input)
        ctx.fault('job:before_commit')
        const result = applyOperation(ctx, row.operation_id, p, 'automatic')
        ctx.fault('job:business_written')
        assertLease(ctx, lease)
        db.prepare(
          "UPDATE jobs SET state='done',finished_at=?,proposal=NULL WHERE id=?",
        ).run(iso(ctx), lease.id)
        db.prepare(
          "UPDATE job_attempts SET outcome='DONE' WHERE job_id=? AND token=?",
        ).run(lease.id, lease.token)
        ctx.fault('job:done_written')
        return result
      })
      .immediate()
    ctx.fault('job:after_commit')
    return result
  }
  return {
    claimJob,
    renewLease,
    failJob,
    saveProposal,
    commitJob,
    job(id: number) {
      const row = jobRow(ctx, id)
      return {
        id: row.id,
        state: row.state,
        attempt: row.attempt,
        token: row.lease_token,
        proposal:
          row.proposal === null
            ? null
            : parseProposal(JSON.parse(row.proposal)),
      }
    },
    jobInput(lease: Lease): {
      event: SourceEventV2
      reference: { eventId: number; generation: number; scopeEpoch: number }
    } {
      const row = assertLease(ctx, lease)
      const e = db
        .prepare(
          `SELECT e.envelope,h.generation FROM source_events e JOIN source_object_heads h ON h.source_id=e.source_id AND h.external_id=e.external_id WHERE e.id=?`,
        )
        .get(row.event_id) as { envelope: string; generation: number }
      return {
        event: JSON.parse(e.envelope) as SourceEventV2,
        reference: {
          eventId: row.event_id,
          generation: e.generation,
          scopeEpoch: row.scope_epoch,
        },
      }
    },
    reprocessEvent(eventId: number, pipelineVersion: string): number {
      requireId(pipelineVersion)
      return db
        .transaction(() => {
          ctx.guard()
          const e = db
            .prepare('SELECT source_id,scope_id FROM source_events WHERE id=?')
            .get(eventId) as { source_id: string; scope_id: string } | undefined
          if (!e) throw new Error('UNKNOWN_EVENT')
          const s = authorized(ctx, e.source_id, e.scope_id)
          const generation = (
            db
              .prepare(
                'SELECT COALESCE(MAX(run_generation),-1)+1 AS n FROM jobs WHERE event_id=? AND pipeline_version=?',
              )
              .get(eventId, pipelineVersion) as { n: number }
          ).n
          if (ctx.depth() >= ctx.limits.queueHigh)
            throw new Error('QUEUE_LIMIT')
          return Number(
            db
              .prepare(
                'INSERT INTO jobs(event_id,pipeline_version,run_generation,operation_id,scope_epoch,created_at) VALUES(?,?,?,?,?,?)',
              )
              .run(
                eventId,
                pipelineVersion,
                generation,
                'event:' + eventId + ':' + pipelineVersion + ':' + generation,
                s.scope_epoch,
                iso(ctx),
              ).lastInsertRowid,
          )
        })
        .immediate()
    },
  }
}

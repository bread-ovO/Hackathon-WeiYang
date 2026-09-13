import { createSourceAssociations } from './source-associations'
import { createPlanChanges } from './plan-changes'
import { eventMetadataFields } from './event-metadata'
import { getSourceStatus } from './source-status'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
import {
  prepareEventProcessing,
  type PreparedEventProcessing,
} from '@memo/application'
import {
  createJobQueue,
  JOB_LEASE_MS,
  MAX_JOB_ATTEMPTS,
  type Job,
  type JobLease,
  type JobErrorCode,
} from './jobs'
import { createRevisionReview } from './revision-review'
import { createRetractions } from './retractions'
import { createTaskModel } from './task-model'
import { createCandidateSearch, projectionTerms } from './search'
export interface ProcessingContext {
  eventId: number
  projectId: string
  event: SourceEvent
  grant: {
    kind: 'source' | 'plugin' | 'github' | 'feishu'
    id: string
    version: number
  }
}
export interface ProcessingResult {
  outcome: 'created' | 'review_required' | 'ignored' | 'already_processed'
  taskIds: string[]
}
const eligible = `(EXISTS(SELECT 1 FROM source_grants g JOIN event_projects ep ON ep.project_id=g.project_id AND ep.event_id=e.id WHERE g.source_id=e.source_id AND g.revoked=0 AND g.error_code IS NULL) OR EXISTS(SELECT 1 FROM plugin_bindings p JOIN event_projects ep ON ep.project_id=p.project_id AND ep.event_id=e.id WHERE p.source_instance_id=e.source_id AND p.enabled=1 AND p.uninstalled=0 AND p.has_error=0) OR EXISTS(SELECT 1 FROM github_connections h JOIN event_projects ep ON ep.project_id=h.project_id AND ep.event_id=e.id WHERE h.source_id=e.source_id AND h.enabled=1 AND h.revoked=0) OR EXISTS(SELECT 1 FROM feishu_connections f JOIN event_projects ep ON ep.project_id=f.project_id AND ep.event_id=e.id WHERE f.source_id=e.source_id AND f.enabled=1 AND f.revoked=0))`
const at = (now: Date) => {
  if (!Number.isFinite(now.getTime())) throw Error('INVALID_PROCESSING_INPUT')
  return now.toISOString()
}
export function migrateProcessing(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
    ALTER TABLE jobs ADD COLUMN processing_skips INTEGER NOT NULL DEFAULT 0 CHECK(processing_skips>=0);
    CREATE TABLE processing_preferences(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)));
    INSERT INTO processing_preferences VALUES(1,1);
    CREATE TABLE processing_results(event_id INTEGER PRIMARY KEY REFERENCES source_events(id),project_id TEXT NOT NULL REFERENCES projects(id),grant_kind TEXT NOT NULL,grant_id TEXT NOT NULL,grant_version INTEGER NOT NULL,rule_version TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN('created','review_required','ignored')),reason TEXT NOT NULL,payload TEXT NOT NULL,task_ids TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(project_id,event_id) REFERENCES event_projects(project_id,event_id));
    CREATE TABLE processing_origins(project_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES source_instances(id),external_id TEXT NOT NULL,candidate_key TEXT NOT NULL,task_id TEXT NOT NULL,PRIMARY KEY(project_id,source_id,external_id,candidate_key),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
    CREATE TABLE processing_evidence(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,event_id INTEGER NOT NULL,quote_start INTEGER NOT NULL,quote_end INTEGER NOT NULL,quote TEXT NOT NULL,UNIQUE(task_id,event_id,quote_start,quote_end),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(project_id,event_id) REFERENCES event_projects(project_id,event_id));
    CREATE TABLE processing_decisions(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,event_id INTEGER NOT NULL REFERENCES processing_results(event_id),actor TEXT NOT NULL CHECK(actor='rule'),outcome TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,event_id),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
    PRAGMA user_version=8;
  `),
  )()
}
export function createProcessing(db: Database.Database) {
  const jobs = createJobQueue(db),
    tasks = createTaskModel(db),
    search = createCandidateSearch(db)
  const enabled = () =>
    (
      db
        .prepare('SELECT enabled FROM processing_preferences WHERE id=1')
        .get() as { enabled: number }
    ).enabled === 1
  function leaseJob(lease: JobLease, now: Date): Job {
    const job = jobs.get(lease.id)
    if (
      !job ||
      job.attempt !== lease.attempt ||
      job.state !== 'running' ||
      !job.leaseUntil ||
      job.leaseUntil <= at(now)
    )
      throw Error('PROCESSING_LEASE_LOST')
    return job
  }
  const authorized = (eventId: number) =>
    !!db
      .prepare(`SELECT 1 FROM source_events e WHERE e.id=? AND ${eligible}`)
      .get(eventId)
  function context(eventId: number): ProcessingContext | null {
    const row = db
      .prepare(
        'SELECT source_id,external_id,revision,occurred_at,role,content,operation,metadata_json FROM source_events WHERE id=?',
      )
      .get(eventId) as
      | {
          source_id: string
          external_id: string
          revision: string
          occurred_at: string
          role: string
          content: string
          metadata_json: string | null
          operation: 'upsert' | 'retract'
        }
      | undefined
    if (!row) return null
    const source = db
      .prepare(
        `SELECT g.project_id AS projectId,g.source_id AS id,g.grant_version AS version FROM source_grants g JOIN event_projects ep ON ep.project_id=g.project_id AND ep.event_id=? WHERE g.source_id=? AND g.revoked=0 AND g.error_code IS NULL`,
      )
      .get(eventId, row.source_id) as
      | { projectId: string; id: string; version: number }
      | undefined
    const plugin = source
      ? undefined
      : (db
          .prepare(
            `SELECT p.project_id AS projectId,p.id,p.grant_version AS version FROM plugin_bindings p JOIN event_projects ep ON ep.project_id=p.project_id AND ep.event_id=? WHERE p.source_instance_id=? AND p.enabled=1 AND p.uninstalled=0 AND p.has_error=0`,
          )
          .get(eventId, row.source_id) as
          | { projectId: string; id: string; version: number }
          | undefined)
    const github =
      source || plugin
        ? undefined
        : (db
            .prepare(
              'SELECT h.project_id AS projectId,h.source_id AS id,h.grant_version AS version FROM github_connections h JOIN event_projects ep ON ep.project_id=h.project_id AND ep.event_id=? WHERE h.source_id=? AND h.enabled=1 AND h.revoked=0',
            )
            .get(eventId, row.source_id) as
            | { projectId: string; id: string; version: number }
            | undefined)
    const feishu =
      source || plugin || github
        ? undefined
        : (db
            .prepare(
              'SELECT f.project_id AS projectId,f.source_id AS id,f.grant_version AS version FROM feishu_connections f JOIN event_projects ep ON ep.project_id=f.project_id AND ep.event_id=? WHERE f.source_id=? AND f.enabled=1 AND f.revoked=0',
            )
            .get(eventId, row.source_id) as
            | { projectId: string; id: string; version: number }
            | undefined)
    const grant = source ?? plugin ?? github ?? feishu
    if (!grant) return null
    return {
      eventId,
      projectId: grant.projectId,
      grant: {
        kind: source
          ? 'source'
          : plugin
            ? 'plugin'
            : github
              ? 'github'
              : 'feishu',
        id: grant.id,
        version: grant.version,
      },
      event: parseSourceEvent({
        schemaVersion: 1,
        ...eventMetadataFields(row.metadata_json),
        sourceInstanceId: row.source_id,
        externalId: row.external_id,
        revision: row.revision,
        occurredAt: row.occurred_at,
        role: row.role,
        text: row.content,
        ...(row.operation === 'retract'
          ? { operation: 'retract' as const }
          : {}),
      }),
    }
  }
  const claim = db.transaction((now: Date): Job | undefined => {
    if (!enabled()) return undefined
    const time = at(now)
    db.prepare(
      `UPDATE jobs SET state='failed',lease_until=NULL,error_code='LEASE_EXPIRED' WHERE id IN (SELECT j.id FROM jobs j JOIN source_events e ON e.id=j.event_id WHERE ${eligible} AND j.state='running' AND (j.lease_until IS NULL OR j.lease_until<=?) AND j.attempt-j.processing_skips>=?)`,
    ).run(time, MAX_JOB_ATTEMPTS)
    const row = db
      .prepare(
        `SELECT j.id FROM jobs j JOIN source_events e ON e.id=j.event_id WHERE ${eligible} AND j.attempt-j.processing_skips<? AND ((j.state='pending' AND (j.next_run IS NULL OR j.next_run<=?)) OR (j.state='running' AND (j.lease_until IS NULL OR j.lease_until<=?))) ORDER BY j.id LIMIT 1`,
      )
      .get(MAX_JOB_ATTEMPTS, time, time) as { id: number } | undefined
    if (!row) return undefined
    db.prepare(
      "UPDATE jobs SET state='running',attempt=attempt+1,lease_until=?,next_run=NULL WHERE id=?",
    ).run(new Date(now.getTime() + JOB_LEASE_MS).toISOString(), row.id)
    return jobs.get(row.id)
  })
  const commit = db.transaction(
    (
      lease: JobLease,
      input: ProcessingContext,
      proposal: PreparedEventProcessing,
      now: Date,
    ): ProcessingResult => {
      const job = jobs.get(lease.id)
      if (!job || job.attempt !== lease.attempt)
        throw Error('PROCESSING_LEASE_LOST')
      const prior = db
        .prepare(
          'SELECT task_ids,payload FROM processing_results WHERE event_id=?',
        )
        .get(job.eventId) as { task_ids: string; payload: string } | undefined
      if (prior && job.state === 'done') {
        const actual = context(job.eventId)
        if (
          !actual ||
          !isDeepStrictEqual(actual, input) ||
          !isDeepStrictEqual(JSON.parse(prior.payload), proposal)
        )
          throw Error('PROCESSING_SOURCE_CHANGED')
        return {
          outcome: 'already_processed',
          taskIds: JSON.parse(prior.task_ids) as string[],
        }
      }
      leaseJob(lease, now)
      if (!enabled()) throw Error('PROCESSING_DISABLED')
      const actual = context(job.eventId)
      if (!actual || !isDeepStrictEqual(actual, input))
        throw Error('PROCESSING_SOURCE_CHANGED')
      const expected = prepareEventProcessing({
        event: actual.event,
        eventId: actual.eventId,
        projectId: actual.projectId,
      })
      if (!isDeepStrictEqual(expected, proposal))
        throw Error('INVALID_PROCESSING_PROPOSAL')
      const origin = db
        .prepare(
          'SELECT DISTINCT task_id AS id FROM processing_origins WHERE project_id=? AND source_id=? AND external_id=?',
        )
        .all(
          actual.projectId,
          actual.event.sourceInstanceId,
          actual.event.externalId,
        ) as { id: string }[]
      // An explicit binding already gives this exact source object a task. A later
      // commitment-shaped revision is a review, never a second candidate/origin.
      const binding = origin.length
        ? null
        : createSourceAssociations(db).resolveObject(
            actual.projectId,
            actual.event.sourceInstanceId,
            actual.event.externalId,
          )
      if (binding && !origin.some((row) => row.id === binding.taskId))
        origin.push({ id: binding.taskId })
      const retraction = createRetractions(db).forEvent(
        actual.projectId,
        actual.eventId,
      )
      if (retraction) {
        const linked = db
          .prepare(
            `SELECT DISTINCT v.task_id AS id FROM (SELECT task_id,project_id,event_id FROM processing_evidence UNION ALL SELECT task_id,project_id,event_id FROM evidence_links) v JOIN source_events e ON e.id=v.event_id WHERE v.project_id=? AND e.source_id=? AND e.external_id=?`,
          )
          .all(
            actual.projectId,
            actual.event.sourceInstanceId,
            actual.event.externalId,
          ) as { id: string }[]
        for (const row of linked)
          if (!origin.some((item) => item.id === row.id)) origin.push(row)
      }
      const reason = retraction
        ? 'source_retracted'
        : origin.length
          ? 'source_revision_requires_review'
          : proposal.reason
      const outcome =
        retraction || origin.length || proposal.outcome === 'needs_review'
          ? 'review_required'
          : proposal.outcome === 'candidates'
            ? 'created'
            : 'ignored'
      const ids = origin.map((row) => row.id),
        time = at(now)
      if (outcome === 'created')
        for (const candidate of proposal.candidates) {
          const id = randomUUID()
          ids.push(id)
          db.prepare(
            "INSERT INTO tasks(id,project_id,title,status,evidence_status,version,manual_version,admission,criteria_version,due_at) VALUES(?,?,?,'todo','unknown',1,0,'candidate',0,?)",
          ).run(id, actual.projectId, candidate.title, candidate.dueAt)
          db.prepare('INSERT INTO processing_origins VALUES(?,?,?,?,?)').run(
            actual.projectId,
            actual.event.sourceInstanceId,
            actual.event.externalId,
            candidate.key,
            id,
          )
          db.prepare(
            'INSERT INTO processing_evidence(project_id,task_id,event_id,quote_start,quote_end,quote) VALUES(?,?,?,?,?,?)',
          ).run(
            actual.projectId,
            id,
            actual.eventId,
            candidate.quoteStart,
            candidate.quoteEnd,
            actual.event.text.slice(candidate.quoteStart, candidate.quoteEnd),
          )
          const task = tasks.get(actual.projectId, id)!
          db.prepare(
            'INSERT INTO task_revisions(task_id,version,decision_id,snapshot) VALUES(?,1,NULL,?)',
          ).run(id, JSON.stringify(task))
          const projection = {
            projectId: actual.projectId,
            candidateId: id,
            title: candidate.title,
            text: '',
            codeIdentifiers: [],
          }
          search.upsert(projection)
          const row = db
            .prepare('SELECT rowid AS id FROM tasks WHERE id=?')
            .get(id) as { id: number }
          db.prepare(
            'INSERT INTO task_listing_fts(rowid,terms) VALUES(?,?)',
          ).run(row.id, projectionTerms(projection))
        }
      createRevisionReview(db).observe(actual.projectId, actual.eventId)
      db.prepare(
        'INSERT INTO processing_results VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        actual.eventId,
        actual.projectId,
        actual.grant.kind,
        actual.grant.id,
        actual.grant.version,
        proposal.version,
        outcome,
        reason,
        JSON.stringify(proposal),
        JSON.stringify(ids),
        time,
      )
      for (const id of ids)
        db.prepare(
          "INSERT INTO processing_decisions(project_id,task_id,event_id,actor,outcome,reason,created_at) VALUES(?,?,?,'rule',?,?,?)",
        ).run(actual.projectId, id, actual.eventId, outcome, reason, time)
      createPlanChanges(db).observe(actual.projectId, actual.eventId, now)
      if (!jobs.complete(lease, now)) throw Error('PROCESSING_LEASE_LOST')
      return { outcome, taskIds: ids }
    },
  )
  return {
    claim(now = new Date()) {
      return claim.immediate(now)
    },
    load(lease: JobLease, now = new Date()) {
      if (!enabled()) return null
      return context(leaseJob(lease, now).eventId)
    },
    commit(
      lease: JobLease,
      input: ProcessingContext,
      proposal: PreparedEventProcessing,
      now = new Date(),
    ) {
      return commit.immediate(
        lease,
        structuredClone(input),
        structuredClone(proposal),
        now,
      )
    },
    fail(
      lease: JobLease,
      code: JobErrorCode,
      retryable: boolean,
      now = new Date(),
    ) {
      if (!enabled()) return false
      const job = jobs.get(lease.id)
      if (!job || !authorized(job.eventId)) return false
      if (
        ![
          'TIMEOUT',
          'RATE_LIMITED',
          'INVALID_OUTPUT',
          'EXECUTION_FAILED',
          'LEASE_EXPIRED',
        ].includes(code) ||
        typeof retryable !== 'boolean'
      )
        throw Error('INVALID_PROCESSING_INPUT')
      const row = db
        .prepare('SELECT processing_skips AS skips FROM jobs WHERE id=?')
        .get(lease.id) as { skips: number }
      const attempts = lease.attempt - row.skips,
        retry = retryable && attempts < MAX_JOB_ATTEMPTS
      return (
        db
          .prepare(
            "UPDATE jobs SET state=?,lease_until=NULL,next_run=?,error_code=? WHERE id=? AND attempt=? AND state='running' AND lease_until>?",
          )
          .run(
            retry ? 'pending' : 'failed',
            retry
              ? new Date(
                  now.getTime() +
                    Math.min(60000, 1000 * 2 ** Math.max(0, attempts - 1)),
                ).toISOString()
              : null,
            code,
            lease.id,
            lease.attempt,
            at(now),
          ).changes === 1
      )
    },
    renew(lease: JobLease, now = new Date()) {
      if (!enabled()) return false
      const job = jobs.get(lease.id)
      return !!job && authorized(job.eventId) && jobs.renew(lease, now)
    },
    release(lease: JobLease, now = new Date()) {
      // Keep the fencing token monotonic. Releasing a cancelled attempt earns a
      // retry credit rather than reusing an old token via attempt-- (ABA).
      return (
        db
          .prepare(
            "UPDATE jobs SET state='pending',lease_until=NULL,next_run=NULL,processing_skips=processing_skips+1 WHERE id=? AND attempt=? AND state='running' AND lease_until>?",
          )
          .run(lease.id, lease.attempt, at(now)).changes === 1
      )
    },
    isEnabled: enabled,
    setEnabled(value: boolean) {
      if (typeof value !== 'boolean') throw Error('INVALID_PROCESSING_INPUT')
      db.prepare('UPDATE processing_preferences SET enabled=? WHERE id=1').run(
        value ? 1 : 0,
      )
      return this.getStatus()
    },
    getStatus() {
      const counts = db
        .prepare(
          `SELECT sum(j.state='pending') AS pending,sum(j.state='running') AS running,sum(j.state='failed') AS failed FROM jobs j JOIN source_events e ON e.id=j.event_id WHERE ${eligible}`,
        )
        .get() as {
        pending: number | null
        running: number | null
        failed: number | null
      }
      const processed = db
        .prepare(
          "SELECT count(*) AS processed,sum(outcome='review_required') AS reviewRequired,max(created_at) AS lastProcessedAt FROM processing_results",
        )
        .get() as {
        processed: number
        reviewRequired: number | null
        lastProcessedAt: string | null
      }
      return {
        enabled: enabled(),
        pending: counts.pending ?? 0,
        running: counts.running ?? 0,
        failed: counts.failed ?? 0,
        processed: processed.processed,
        reviewRequired: processed.reviewRequired ?? 0,
        lastProcessedAt: processed.lastProcessedAt,
        candidates: (
          db.prepare('SELECT count(*) AS n FROM processing_origins').get() as {
            n: number
          }
        ).n,
      }
    },
    getTaskEvidence(projectId: string, taskId: string) {
      if (!tasks.get(projectId, taskId)) throw Error('TASK_NOT_IN_PROJECT')
      const rows = db
        .prepare(
          `SELECT v.event_id AS eventId,e.source_id AS sourceInstanceId,e.external_id AS externalId,e.revision,v.quote_start AS quoteStart,v.quote_end AS quoteEnd,v.quote,v.reference_id AS referenceId,v.reference_status AS storedReferenceStatus,v.invalidated_by_event_id AS storedInvalidatedBy,r.reason,r.created_at AS createdAt,r.rule_version AS policyVersion,'rule' AS actor,r.outcome,
      CASE WHEN EXISTS(SELECT 1 FROM source_events later JOIN event_projects ep ON ep.event_id=later.id WHERE ep.project_id=v.project_id AND later.source_id=e.source_id AND later.external_id=e.external_id AND later.revision<>e.revision AND later.id>e.id) THEN 'review_required' ELSE 'current' END AS revisionStatus
      FROM (SELECT project_id,task_id,event_id,quote_start,quote_end,quote,CAST(id AS TEXT) AS reference_id,reference_status,invalidated_by_event_id FROM processing_evidence
       UNION ALL SELECT d.project_id,d.task_id,d.event_id,0,0,substr(e.content,1,1024),NULL,NULL,NULL FROM processing_decisions d JOIN source_events e ON e.id=d.event_id WHERE d.outcome='review_required') v JOIN source_events e ON e.id=v.event_id JOIN processing_results r ON r.event_id=v.event_id WHERE v.project_id=? AND v.task_id=? ORDER BY CASE WHEN r.outcome='created' THEN 0 ELSE 1 END,v.event_id DESC LIMIT 100`,
        )
        .all(projectId, taskId) as {
        eventId: number
        sourceInstanceId: string
        externalId: string
        revision: string
        quoteStart: number
        quoteEnd: number
        quote: string
        referenceId: string | null
        storedReferenceStatus: 'available' | 'invalidated' | null
        storedInvalidatedBy: number | null
        reason: string
        createdAt: string
        policyVersion: string
        actor: 'rule'
        outcome: 'created' | 'review_required'
        revisionStatus: 'current' | 'review_required'
      }[]
      return rows.map((original) => {
        const retraction = createRetractions(db).forEvent(
          projectId,
          original.eventId,
        )
        const { storedReferenceStatus, storedInvalidatedBy, ...publicFields } =
          original
        if (
          original.outcome === 'created' &&
          (storedReferenceStatus !==
            (retraction ? 'invalidated' : 'available') ||
            storedInvalidatedBy !== (retraction?.eventId ?? null))
        )
          throw Error('INVALID_RETRACTION_DATA')
        const review = original.referenceId
          ? createRevisionReview(db).reviewReference({
              projectId,
              taskId,
              referenceKind: 'processing',
              referenceId: original.referenceId,
              limit: 1,
            })
          : null
        const selectedSameContent = review?.confirmedEventId
          ? !!db
              .prepare(
                'SELECT 1 FROM source_events a JOIN source_events b ON a.content=b.content AND a.role=b.role WHERE a.id=? AND b.id=?',
              )
              .get(original.eventId, review.confirmedEventId)
          : false
        const revisionInvalid =
          review?.reference.status === 'review_required' ||
          (review?.reference.status === 'confirmed' && !selectedSameContent)
        const row = {
          ...publicFields,
          sourceStatus: getSourceStatus(
            db,
            projectId,
            original.sourceInstanceId,
          ),
          referenceKind: original.referenceId ? ('processing' as const) : null,
          referenceVersion: review?.reference.version ?? null,
          knownContentSetDigest: review?.knownContentSetDigest ?? null,
          revisionReviewStatus: review?.reference.status ?? null,
          confirmedEventId: review?.confirmedEventId ?? null,
          confirmation: review?.confirmation ?? null,
          eventStatus: retraction
            ? ('retracted' as const)
            : ('present' as const),
          referenceStatus:
            retraction || revisionInvalid
              ? ('invalidated' as const)
              : ('available' as const),
          retraction,
        }
        return row.outcome === 'review_required'
          ? {
              ...row,
              quoteKind: 'revision_excerpt' as const,
              quoteEnd: row.quote.length,
              revisionStatus: 'review_required' as const,
            }
          : { ...row, quoteKind: 'exact' as const }
      })
    },
  }
}

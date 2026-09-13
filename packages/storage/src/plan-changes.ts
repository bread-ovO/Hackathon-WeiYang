import type Database from 'better-sqlite3'
import { parseSourceEvent } from '@memo/contracts'
import {
  comparePlanUpdates,
  parseContextTimestamp,
  extractExplicitPlanChange,
} from '@memo/domain'
import { eventMetadataFields } from './event-metadata'
import { getSourceStatus, type CurrentSourceStatus } from './source-status'
import { createTaskModel } from './task-model'
import { createRetractions } from './retractions'
export interface PlanChangeProposal {
  id: number
  taskId: string
  dueAt: string
  quote: string
  eventId: number
  sourceInstanceId: string
  externalId: string
  revision: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  occurredAt: string
  receivedAt: string
  createdAt: string
  status: 'pending' | 'applied'
  guard:
    | 'ready'
    | 'late_occurrence'
    | 'simultaneous_conflict'
    | 'source_unavailable'
    | 'retracted'
    | 'task_changed'
    | 'unknown_revision_order'
    | 'reference_invalidated'
    | 'identity_unknown'
    | 'identity_mismatch'
  sourceStatus: CurrentSourceStatus
  taskVersion: number
  criteriaVersion: number
  manualVersion: number
  appliedAt: string | null
}
type Row = {
  id: number
  project_id: string
  task_id: string
  event_id: number
  baseline_event_id: number
  due_at: string
  quote: string
  task_version: number
  criteria_version: number
  manual_version: number
  created_at: string
  applied_at: string | null
  decision_id: number | null
}
type Event = {
  id: number
  source_id: string
  external_id: string
  revision: string
  role: PlanChangeProposal['role']
  operation: 'upsert' | 'retract'
  content: string
  occurred_at: string
  received_at: string
  metadata_json: string | null
}
export function migratePlanChanges(db: Database.Database) {
  db.transaction(() =>
    db.exec(`CREATE TABLE plan_change_proposals (
 id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,event_id INTEGER NOT NULL,baseline_event_id INTEGER NOT NULL,due_at TEXT NOT NULL,quote TEXT NOT NULL CHECK(length(quote)<=240),task_version INTEGER NOT NULL CHECK(task_version>=1),criteria_version INTEGER NOT NULL CHECK(criteria_version>=0),manual_version INTEGER NOT NULL CHECK(manual_version>=0),created_at TEXT NOT NULL,applied_at TEXT,decision_id INTEGER REFERENCES decisions(id),UNIQUE(project_id,task_id,event_id),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(project_id,event_id) REFERENCES event_projects(project_id,event_id),FOREIGN KEY(project_id,baseline_event_id) REFERENCES event_projects(project_id,event_id),CHECK((applied_at IS NULL AND decision_id IS NULL) OR (applied_at IS NOT NULL AND decision_id IS NOT NULL)));
 CREATE INDEX plan_changes_scope ON plan_change_proposals(project_id,task_id,id);
 PRAGMA user_version=16;`),
  )()
}
export function createPlanChanges(db: Database.Database) {
  const tasks = createTaskModel(db)
  const invalid = () => {
    throw Error('PLAN_CHANGE_INVALID_INPUT')
  }
  function id(value: unknown): asserts value is string {
    if (
      typeof value !== 'string' ||
      !value.length ||
      value.length > 256 ||
      /[\s\u0000-\u001f\u007f]/u.test(value)
    )
      invalid()
  }
  function number(value: unknown, min = 0): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < min) invalid()
  }
  function scope(project: string, task: string) {
    id(project)
    id(task)
    const value = tasks.get(project, task)
    if (!value) throw Error('PLAN_CHANGE_NOT_FOUND')
    return value
  }
  function event(project: string, eventId: number) {
    const e = db
      .prepare(
        'SELECT e.* FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id=?',
      )
      .get(project, eventId) as Event | undefined
    if (!e) throw Error('PLAN_CHANGE_NOT_FOUND')
    parseSourceEvent({
      schemaVersion: 1,
      sourceInstanceId: e.source_id,
      externalId: e.external_id,
      revision: e.revision,
      role: e.role,
      text: e.content,
      operation: e.operation,
      occurredAt: e.occurred_at,
      ...eventMetadataFields(e.metadata_json),
    })
    parseContextTimestamp(e.occurred_at)
    parseContextTimestamp(e.received_at)
    return e
  }
  function linked(project: string, e: Event) {
    const metadata = eventMetadataFields(e.metadata_json).metadata
    const target = metadata?.replyToExternalId ?? e.external_id
    return db
      .prepare(
        'SELECT DISTINCT task_id FROM processing_origins WHERE project_id=? AND source_id=? AND external_id=? LIMIT 2',
      )
      .all(project, e.source_id, target) as { task_id: string }[]
  }
  function baseline(project: string, taskId: string) {
    return db
      .prepare(
        `SELECT e.id FROM processing_evidence p JOIN source_events e ON e.id=p.event_id WHERE p.project_id=? AND p.task_id=? ORDER BY p.id LIMIT 1`,
      )
      .get(project, taskId) as { id: number } | undefined
  }
  function order(
    project: string,
    taskId: string,
    current: Event,
    incoming: Event,
    currentDue: string | null,
    incomingDue: string,
  ) {
    const identity = {
      sourceInstanceId: incoming.source_id,
      namespace: 'task-plan',
      subjectId: taskId,
      projectId: project,
    }
    return comparePlanUpdates(
      {
        identity,
        eventId: current.external_id,
        revision: current.revision,
        time: {
          occurredAt: current.occurred_at,
          receivedAt: current.received_at,
        },
        planFingerprint: currentDue ?? 'no-deadline',
      },
      {
        identity,
        eventId: incoming.external_id,
        revision: incoming.revision,
        time: {
          occurredAt: incoming.occurred_at,
          receivedAt: incoming.received_at,
        },
        planFingerprint: incomingDue,
      },
    )
  }
  function validateRow(row: Row) {
    ;[row.id, row.event_id, row.baseline_event_id, row.task_version].forEach(
      (value) => number(value, 1),
    )
    ;[row.criteria_version, row.manual_version].forEach((value) =>
      number(value),
    )
    id(row.project_id)
    id(row.task_id)
    for (const date of [
      row.created_at,
      row.due_at,
      ...(row.applied_at === null ? [] : [row.applied_at]),
    ])
      if (typeof date !== 'string' || new Date(date).toISOString() !== date)
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    if ((row.applied_at === null) !== (row.decision_id === null))
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    if (row.decision_id !== null) {
      number(row.decision_id, 1)
      const d = db
        .prepare(
          'SELECT d.*,r.snapshot FROM decisions d JOIN task_revisions r ON r.decision_id=d.id AND r.task_id=d.task_id JOIN tasks t ON t.id=d.task_id WHERE d.id=? AND d.task_id=? AND t.project_id=?',
        )
        .get(row.decision_id, row.task_id, row.project_id) as
        | {
            actor: string
            scope: string
            payload: string
            input_refs: string
            task_version: number
            criteria_version: number
            manual_version: number
            snapshot: string
          }
        | undefined
      if (
        !d ||
        d.actor !== 'manual' ||
        d.scope !== 'dueAt' ||
        d.task_version !== row.task_version + 1 ||
        d.criteria_version !== row.criteria_version ||
        d.manual_version !== row.manual_version + 1
      )
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      const payload = JSON.parse(d.payload),
        refs = JSON.parse(d.input_refs),
        snapshot = JSON.parse(d.snapshot)
      if (
        Object.keys(payload).length !== 1 ||
        payload.dueAt !== row.due_at ||
        !Array.isArray(refs) ||
        refs.length !== 1 ||
        refs[0] !== row.event_id ||
        snapshot.id !== row.task_id ||
        snapshot.projectId !== row.project_id ||
        snapshot.dueAt !== row.due_at ||
        snapshot.version !== d.task_version
      )
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    }
  }
  function changed(projectId: string, proof: Event) {
    const siblings = db
      .prepare(
        'SELECT role,content,metadata_json FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.source_id=? AND e.external_id=? LIMIT 1001',
      )
      .all(projectId, proof.source_id, proof.external_id) as Pick<
      Event,
      'role' | 'content' | 'metadata_json'
    >[]
    if (siblings.length > 1000) return true
    const metadata = eventMetadataFields(proof.metadata_json).metadata
    const canonical = (value: typeof metadata) =>
      JSON.stringify([
        value?.author?.namespace ?? null,
        value?.author?.subjectId ?? null,
        value?.replyToExternalId ?? null,
      ])
    return siblings.some(
      (s) =>
        s.role !== proof.role ||
        s.content !== proof.content ||
        canonical(eventMetadataFields(s.metadata_json).metadata) !==
          canonical(metadata),
    )
  }
  function project(row: Row): PlanChangeProposal {
    validateRow(row)
    const task = scope(row.project_id, row.task_id),
      e = event(row.project_id, row.event_id),
      original = event(row.project_id, row.baseline_event_id),
      extract = extractExplicitPlanChange({
        text: e.content,
        role: e.role,
        operation: e.operation,
      })
    if (
      original.source_id !== e.source_id ||
      baseline(row.project_id, row.task_id)?.id !== row.baseline_event_id ||
      !extract ||
      extract.quote !== row.quote ||
      extract.dueAt !== row.due_at ||
      linked(row.project_id, e).length !== 1 ||
      linked(row.project_id, e)[0]?.task_id !== row.task_id
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    const latest = db
      .prepare(
        'SELECT * FROM plan_change_proposals WHERE project_id=? AND task_id=? AND applied_at IS NOT NULL ORDER BY decision_id DESC LIMIT 1',
      )
      .get(row.project_id, row.task_id) as Row | undefined
    if (latest) validateRow(latest)
    const current = latest ? event(row.project_id, latest.event_id) : original
    const decision = order(
      row.project_id,
      row.task_id,
      current,
      e,
      latest?.due_at ?? null,
      row.due_at,
    )
    const sourceStatus = getSourceStatus(db, row.project_id, e.source_id)
    const incomingTime = parseContextTimestamp(e.occurred_at),
      currentTime = parseContextTimestamp(current.occurred_at)
    const older =
      incomingTime.epochSeconds < currentTime.epochSeconds ||
      (incomingTime.epochSeconds === currentTime.epochSeconds &&
        incomingTime.nanosecond < currentTime.nanosecond)
    const baseAuthor = eventMetadataFields(original.metadata_json).metadata
        ?.author,
      incomingAuthor = eventMetadataFields(e.metadata_json).metadata?.author
    let guard: PlanChangeProposal['guard'] = 'ready'
    if (sourceStatus !== 'active') guard = 'source_unavailable'
    else if (
      createRetractions(db).forEvent(row.project_id, e.id) ||
      createRetractions(db).forEvent(row.project_id, original.id) ||
      createRetractions(db).forEvent(row.project_id, current.id)
    )
      guard = 'retracted'
    else if (older || decision.reason === 'late_occurrence')
      guard = 'late_occurrence'
    else if (
      decision.reason === 'unknown_revision_order' ||
      decision.reason === 'revision_conflict'
    )
      guard = 'unknown_revision_order'
    else if (decision.action === 'confirm' || decision.action === 'keep')
      guard = 'simultaneous_conflict'
    else if (
      [original, current, e].some((proof) => changed(row.project_id, proof))
    )
      guard = 'reference_invalidated'
    else if (!baseAuthor || !incomingAuthor) guard = 'identity_unknown'
    else if (
      baseAuthor.namespace !== incomingAuthor.namespace ||
      baseAuthor.subjectId !== incomingAuthor.subjectId
    )
      guard = 'identity_mismatch'
    else if (
      db
        .prepare(
          'SELECT 1 FROM source_events other JOIN event_projects ep ON ep.event_id=other.id WHERE ep.project_id=? AND other.source_id=? AND other.external_id=? AND (other.role<>? OR other.content<>?) LIMIT 1',
        )
        .get(row.project_id, e.source_id, e.external_id, e.role, e.content)
    )
      guard = 'reference_invalidated'
    else if (
      db
        .prepare(
          "SELECT 1 FROM processing_evidence WHERE project_id=? AND task_id=? AND event_id=? AND reference_status='available'",
        )
        .get(row.project_id, row.task_id, row.baseline_event_id) === undefined
    )
      guard = 'reference_invalidated'
    else if (
      task.version !== row.task_version ||
      task.criteriaVersion !== row.criteria_version ||
      task.manualVersion !== row.manual_version
    )
      guard = 'task_changed'
    return {
      id: row.id,
      taskId: row.task_id,
      dueAt: row.due_at,
      quote: row.quote,
      eventId: e.id,
      sourceInstanceId: e.source_id,
      externalId: e.external_id,
      revision: e.revision,
      role: e.role,
      occurredAt: e.occurred_at,
      receivedAt: e.received_at,
      createdAt: row.created_at,
      status: row.applied_at ? 'applied' : 'pending',
      guard,
      sourceStatus,
      taskVersion: row.task_version,
      criteriaVersion: row.criteria_version,
      manualVersion: row.manual_version,
      appliedAt: row.applied_at,
    }
  }
  return {
    observe(projectId: string, eventId: number, now: Date) {
      const e = event(projectId, eventId),
        extract = extractExplicitPlanChange({
          text: e.content,
          role: e.role,
          operation: e.operation,
        })
      if (!extract) return
      const targets = linked(projectId, e)
      if (targets.length !== 1) return
      const task = scope(projectId, targets[0]!.task_id),
        base = baseline(projectId, task.id)
      if (!base || base.id === e.id) return
      db.prepare(
        'INSERT OR IGNORE INTO plan_change_proposals(project_id,task_id,event_id,baseline_event_id,due_at,quote,task_version,criteria_version,manual_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        projectId,
        task.id,
        e.id,
        base.id,
        extract.dueAt,
        extract.quote,
        task.version,
        task.criteriaVersion,
        task.manualVersion,
        now.toISOString(),
      )
    },
    exportForTasks(
      projectId: string,
      taskIds: string[],
      includeSourceText: boolean,
    ) {
      id(projectId)
      if (
        !Array.isArray(taskIds) ||
        taskIds.length > 1000 ||
        typeof includeSourceText !== 'boolean'
      )
        invalid()
      taskIds.forEach((value) => scope(projectId, value))
      if (!taskIds.length) return []
      const rows = db
        .prepare(
          `SELECT * FROM plan_change_proposals WHERE project_id=? AND task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id LIMIT 50001`,
        )
        .all(projectId, ...taskIds) as Row[]
      if (rows.length > 50000) throw Error('EXPORT_LIMIT_EXCEEDED')
      return rows.map((row) => {
        const view = project(row)
        return {
          ...view,
          quote: includeSourceText ? view.quote : null,
          baselineEventId: row.baseline_event_id,
          decisionId: row.decision_id,
        }
      })
    },
    list: db.transaction(
      (input: {
        projectId: string
        taskId: string
        cursor?: string
        limit?: number
      }) => {
        if (
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input) ||
          Object.keys(input).some(
            (k) => !['projectId', 'taskId', 'cursor', 'limit'].includes(k),
          )
        )
          invalid()
        scope(input.projectId, input.taskId)
        const limit = input.limit ?? 20
        number(limit, 1)
        if (limit > 50) invalid()
        let before = Number.MAX_SAFE_INTEGER
        if (input.cursor !== undefined) {
          if (
            typeof input.cursor !== 'string' ||
            input.cursor.length > 4096 ||
            !/^[A-Za-z0-9_-]+$/.test(input.cursor)
          )
            invalid()
          try {
            const c = JSON.parse(
              Buffer.from(input.cursor, 'base64url').toString('utf8'),
            )
            if (
              !Array.isArray(c) ||
              c.length !== 3 ||
              c[0] !== input.projectId ||
              c[1] !== input.taskId
            )
              invalid()
            number(c[2], 1)
            before = c[2]
          } catch {
            invalid()
          }
        }
        const rows = db
          .prepare(
            'SELECT * FROM plan_change_proposals WHERE project_id=? AND task_id=? AND id<? ORDER BY id DESC LIMIT ?',
          )
          .all(input.projectId, input.taskId, before, limit + 1) as Row[]
        return {
          proposals: rows.slice(0, limit).map(project),
          nextCursor:
            rows.length > limit
              ? Buffer.from(
                  JSON.stringify([
                    input.projectId,
                    input.taskId,
                    rows[limit - 1]!.id,
                  ]),
                ).toString('base64url')
              : null,
        }
      },
    ),
    confirm: db.transaction(
      (
        input: {
          projectId: string
          taskId: string
          proposalId: number
          expectedVersion: number
          expectedCriteriaVersion: number
          expectedManualVersion: number
          reason: string
        },
        actorId: string,
      ) => {
        scope(input.projectId, input.taskId)
        number(input.proposalId, 1)
        id(actorId)
        if (
          typeof input.reason !== 'string' ||
          !input.reason.trim() ||
          input.reason.length > 512
        )
          invalid()
        const row = db
          .prepare(
            'SELECT * FROM plan_change_proposals WHERE project_id=? AND task_id=? AND id=?',
          )
          .get(input.projectId, input.taskId, input.proposalId) as
          | Row
          | undefined
        if (!row) throw Error('PLAN_CHANGE_NOT_FOUND')
        const view = project(row)
        if (view.status !== 'pending' || view.guard !== 'ready')
          throw Error('PLAN_CHANGE_NOT_APPLICABLE')
        if (
          input.expectedVersion !== row.task_version ||
          input.expectedCriteriaVersion !== row.criteria_version ||
          input.expectedManualVersion !== row.manual_version
        )
          throw Error('VERSION_CONFLICT')
        const task = tasks.update(
          {
            projectId: input.projectId,
            taskId: input.taskId,
            expectedVersion: input.expectedVersion,
            expectedCriteriaVersion: input.expectedCriteriaVersion,
            expectedManualVersion: input.expectedManualVersion,
          },
          { dueAt: row.due_at },
          { actorId, reason: input.reason },
        )
        const revision = db
          .prepare(
            'SELECT decision_id FROM task_revisions WHERE task_id=? AND version=?',
          )
          .get(task.id, task.version) as { decision_id: number }
        db.prepare(
          'UPDATE decisions SET input_refs=? WHERE id=? AND task_id=?',
        ).run(JSON.stringify([row.event_id]), revision.decision_id, task.id)
        db.prepare(
          'UPDATE plan_change_proposals SET applied_at=?,decision_id=? WHERE id=? AND applied_at IS NULL',
        ).run(new Date().toISOString(), revision.decision_id, row.id)
        return task
      },
    ),
  }
}

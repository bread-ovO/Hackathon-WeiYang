import {
  parseProposal,
  sourceSlice,
  parseEventV2,
  type DecisionProposal,
  type TaskCommand,
  type OperationResult,
} from '@memo/contracts'
import type { StoredTask, TaskStatus, EvidenceStatus } from '@memo/domain'
import { iso, type Context } from './context'
import { authorized } from './ingestion'
import { syncSearch } from './search'
import { digest, bytes, requireId } from './util'

interface TaskRow {
  id: string
  title: string
  project_id: string | null
  intake: StoredTask['intake']
  status: TaskStatus | null
  evidence_status: EvidenceStatus
  version: number
  criteria_version: number
  manual_version: number
  archived_at: string | null
  legacy: number
  due_at: string | null
  plan_effective_at: string | null
  plan_event_id: number | null
  deleted_at: string | null
}
export function taskRow(ctx: Context, id: string): TaskRow | undefined {
  return ctx.db
    .prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL')
    .get(id) as TaskRow | undefined
}
export function getTask(ctx: Context, id: string): StoredTask | undefined {
  const t = taskRow(ctx, id)
  return t
    ? {
        id: t.id,
        title: t.title,
        projectId: t.project_id,
        intake: t.intake,
        status: t.status,
        evidenceStatus: t.evidence_status,
        version: t.version,
        criteriaVersion: t.criteria_version,
        manualVersion: t.manual_version,
        archivedAt: t.archived_at,
        legacy: !!t.legacy,
        dueAt: t.due_at,
      }
    : undefined
}
export function validateInputs(ctx: Context, p: DecisionProposal): void {
  const seen = new Set<number>()
  for (const input of p.inputs) {
    if (seen.has(input.eventId)) throw new Error('DUPLICATE_INPUT_REF')
    seen.add(input.eventId)
    const row = ctx.db
      .prepare(
        `SELECT e.source_id,e.scope_id,h.generation FROM source_events e JOIN source_object_heads h
      ON e.source_id=h.source_id AND e.external_id=h.external_id WHERE e.id=?`,
      )
      .get(input.eventId) as
      | { source_id: string; scope_id: string; generation: number }
      | undefined
    if (!row) throw new Error('UNKNOWN_EVENT')
    authorized(ctx, row.source_id, row.scope_id, input.scopeEpoch)
    if (row.generation !== input.generation) throw new Error('STALE_EVIDENCE')
  }
  for (const ref of p.mappings) {
    const row = ctx.db
      .prepare(
        'SELECT m.version,m.active,l.source_id AS left_source,r.source_id AS right_source FROM identity_mappings m JOIN identities l ON l.id=m.left_id JOIN identities r ON r.id=m.right_id WHERE m.id=?',
      )
      .get(ref.id) as
      | {
          version: number
          active: number
          left_source: string
          right_source: string
        }
      | undefined
    if (!row || !row.active || row.version !== ref.version)
      throw new Error('STALE_MAPPING')
    authorized(ctx, row.left_source)
    authorized(ctx, row.right_source)
  }
}
function linkedEvent(
  ctx: Context,
  taskId: string,
  eventId: number,
  p: DecisionProposal,
): {
  envelope: string
  state: string
  current: number | null
  source_id: string
  scope_id: string
} {
  if (!p.inputs.some((i) => i.eventId === eventId))
    throw new Error('MISSING_INPUT_REF')
  const row = ctx.db
    .prepare(
      `SELECT e.envelope,e.source_id,e.scope_id,h.state,h.event_id AS current FROM source_events e JOIN source_object_heads h
    ON h.source_id=e.source_id AND h.external_id=e.external_id WHERE e.id=?`,
    )
    .get(eventId) as
    | {
        envelope: string
        state: string
        current: number | null
        source_id: string
        scope_id: string
      }
    | undefined
  if (!row) throw new Error('UNKNOWN_EVENT')
  if (
    !ctx.db
      .prepare(
        'SELECT 1 FROM task_sources WHERE task_id=? AND source_id=? AND scope_id=?',
      )
      .get(taskId, row.source_id, row.scope_id)
  )
    throw new Error('UNLINKED_SOURCE')
  return row
}
function evidenceProjection(ctx: Context, taskId: string): EvidenceStatus {
  const t = taskRow(ctx, taskId)!
  const criteria = ctx.db
    .prepare('SELECT id FROM criteria WHERE task_id=? AND version=?')
    .all(taskId, t.criteria_version) as { id: string }[]
  if (!criteria.length) return 'unknown'
  const evidence = ctx.db
    .prepare(
      `SELECT l.criterion_id,l.relation,l.validity,e.scope_id,s.active,s.scopes,h.event_id,h.state,l.event_id AS evidence_event
    FROM evidence_links l JOIN source_events e ON e.id=l.event_id JOIN source_instances s ON s.id=e.source_id
    JOIN source_object_heads h ON h.source_id=e.source_id AND h.external_id=e.external_id
    WHERE l.task_id=? AND l.criteria_version=?`,
    )
    .all(taskId, t.criteria_version) as {
    criterion_id: string
    relation: string
    validity: string
    scope_id: string
    active: number
    scopes: string
    event_id: number | null
    state: string
    evidence_event: number
  }[]
  const valid = evidence.filter(
    (e) =>
      e.validity === 'valid' &&
      e.active &&
      JSON.parse(e.scopes).includes(e.scope_id) &&
      e.state === 'current' &&
      e.event_id === e.evidence_event,
  )
  if (valid.some((e) => e.relation === 'oppose')) return 'conflict'
  const supported = new Set(
    valid.filter((e) => e.relation === 'support').map((e) => e.criterion_id),
  )
  return criteria.every((c) => supported.has(c.id))
    ? 'sufficient'
    : supported.size
      ? 'partial'
      : 'unknown'
}
const fields: Record<TaskCommand['kind'], string> = {
  create: 'title',
  set_status: 'status',
  set_title: 'title',
  set_intake: 'intake',
  archive: 'archive',
  set_criteria: 'criteria',
  add_evidence: 'evidence',
  release_override: 'override',
  link_source: 'source',
  set_due: 'due',
}

// Called within the same transaction as job completion. No model receives this database handle.
export function applyOperation(
  ctx: Context,
  operationId: string,
  input: unknown,
  actor: string,
): OperationResult {
  requireId(operationId)
  requireId(actor)
  const p = parseProposal(input),
    hash = digest({ p, actor })
  const prior = ctx.db
    .prepare('SELECT digest,result FROM operation_commits WHERE id=?')
    .get(operationId) as { digest: string; result: string } | undefined
  if (prior) {
    if (prior.digest !== hash) throw new Error('OPERATION_CONTENT_CONFLICT')
    return JSON.parse(prior.result) as OperationResult
  }
  ctx.guard(bytes(p))
  validateInputs(ctx, p)
  const manual = actor !== 'automatic'
  const ids = [...new Set(p.commands.map((c) => c.taskId))]
  const initial = new Map<string, TaskRow | undefined>()
  if (new Set(p.expected.map((g) => g.taskId)).size !== p.expected.length)
    throw new Error('DUPLICATE_EXPECTED_VERSION')
  for (const id of ids) {
    const t = taskRow(ctx, id),
      guard = p.expected.find((g) => g.taskId === id)
    if (
      !guard ||
      guard.version !== (t?.version ?? 0) ||
      guard.criteriaVersion !== (t?.criteria_version ?? 0) ||
      guard.manualVersion !== (t?.manual_version ?? 0)
    )
      throw new Error('VERSION_CONFLICT')
    if (t?.legacy && !manual) throw new Error('LEGACY_UNVERIFIED')
    for (const mapping of p.mappings) {
      const scope = ctx.db
        .prepare('SELECT project_id FROM identity_mappings WHERE id=?')
        .get(mapping.id) as { project_id: string }
      const creation = p.commands.find(
        (c) => c.taskId === id && c.kind === 'create',
      )
      const projectId =
        t?.project_id ??
        (creation?.kind === 'create' ? creation.projectId : null)
      if (scope.project_id !== projectId)
        throw new Error('MAPPING_SCOPE_CONFLICT')
    }
    initial.set(id, t)
  }
  for (const c of p.commands) {
    if (!manual && ['release_override', 'link_source'].includes(c.kind))
      throw new Error('MANUAL_ACTION_REQUIRED')
    if (
      !manual &&
      ctx.db
        .prepare(
          'SELECT 1 FROM manual_overrides WHERE task_id=? AND field=? AND active=1',
        )
        .get(c.taskId, fields[c.kind])
    )
      throw new Error('MANUAL_OVERRIDE')
    if (c.kind === 'create') {
      if (taskRow(ctx, c.taskId)) throw new Error('TASK_EXISTS')
      authorized(ctx, c.sourceId, c.scopeId)
      if (
        !manual &&
        !p.inputs.some((i) =>
          ctx.db
            .prepare(
              'SELECT 1 FROM source_events WHERE id=? AND source_id=? AND scope_id=?',
            )
            .get(i.eventId, c.sourceId, c.scopeId),
        )
      )
        throw new Error('MISSING_ORIGIN')
      ctx.db
        .prepare(
          "INSERT INTO tasks(id,title,project_id,intake,status,evidence_status,updated_at) VALUES(?,?,?,'candidate',NULL,'unknown',?)",
        )
        .run(c.taskId, c.title, c.projectId, iso(ctx))
      ctx.db
        .prepare('INSERT INTO task_sources VALUES(?,?,?)')
        .run(c.taskId, c.sourceId, c.scopeId)
      continue
    }
    const task = taskRow(ctx, c.taskId)
    if (!task) throw new Error('UNKNOWN_TASK')
    // Every update stays inside the currently visible source scope of the task.
    const scopes = ctx.db
      .prepare('SELECT source_id,scope_id FROM task_sources WHERE task_id=?')
      .all(c.taskId) as { source_id: string; scope_id: string }[]
    if (!manual)
      for (const s of scopes) authorized(ctx, s.source_id, s.scope_id)
    if (!manual && !scopes.length) throw new Error('UNLINKED_SOURCE')
    if (
      !manual &&
      !p.inputs.some((i) =>
        ctx.db
          .prepare(
            'SELECT 1 FROM source_events e JOIN task_sources ts ON ts.source_id=e.source_id AND ts.scope_id=e.scope_id WHERE e.id=? AND ts.task_id=?',
          )
          .get(i.eventId, c.taskId),
      )
    )
      throw new Error('UNLINKED_SOURCE')
    switch (c.kind) {
      case 'set_title':
        ctx.db
          .prepare('UPDATE tasks SET title=? WHERE id=?')
          .run(c.title, c.taskId)
        break
      case 'set_intake':
        ctx.db
          .prepare(
            "UPDATE tasks SET intake=?,status=CASE WHEN ?='accepted' THEN COALESCE(status,'todo') ELSE status END WHERE id=?",
          )
          .run(c.intake, c.intake, c.taskId)
        break
      case 'archive':
        ctx.db
          .prepare('UPDATE tasks SET archived_at=? WHERE id=?')
          .run(c.archivedAt, c.taskId)
        break
      case 'link_source':
        authorized(ctx, c.sourceId, c.scopeId)
        ctx.db
          .prepare('INSERT OR IGNORE INTO task_sources VALUES(?,?,?)')
          .run(c.taskId, c.sourceId, c.scopeId)
        break
      case 'release_override':
        ctx.db
          .prepare(
            'UPDATE manual_overrides SET active=0 WHERE task_id=? AND field=?',
          )
          .run(c.taskId, c.field)
        break
      case 'set_criteria': {
        const version = task.criteria_version + 1
        if (new Set(c.criteria.map((v) => v.id)).size !== c.criteria.length)
          throw new Error('DUPLICATE_CRITERION')
        ctx.db
          .prepare('INSERT INTO criterion_sets VALUES(?,?)')
          .run(c.taskId, version)
        for (const criterion of c.criteria) {
          if (!manual && criterion.originEventId === null)
            throw new Error('MISSING_CRITERION_ORIGIN')
          if (criterion.originEventId !== null)
            linkedEvent(ctx, c.taskId, criterion.originEventId, p)
          ctx.db
            .prepare('INSERT INTO criteria VALUES(?,?,?,?,?)')
            .run(
              c.taskId,
              version,
              criterion.id,
              criterion.description,
              criterion.originEventId,
            )
        }
        ctx.db
          .prepare(
            "UPDATE tasks SET criteria_version=?,evidence_status='unknown' WHERE id=?",
          )
          .run(version, c.taskId)
        break
      }
      case 'add_evidence': {
        for (const link of c.links) {
          if (link.criteriaVersion !== task.criteria_version)
            throw new Error('CRITERIA_VERSION_CONFLICT')
          const e = linkedEvent(ctx, c.taskId, link.eventId, p)
          sourceSlice(
            parseEventV2(JSON.parse(e.envelope)),
            link.start,
            link.end,
          )
          const validity =
            e.state === 'current' && e.current === link.eventId
              ? 'valid'
              : e.state === 'tombstone'
                ? 'invalid'
                : 'needs_review'
          ctx.db
            .prepare(
              'INSERT OR IGNORE INTO evidence_links(task_id,criteria_version,criterion_id,event_id,relation,validity,start,end) VALUES(?,?,?,?,?,?,?,?)',
            )
            .run(
              c.taskId,
              link.criteriaVersion,
              link.criterionId,
              link.eventId,
              link.relation,
              validity,
              link.start,
              link.end,
            )
        }
        ctx.db
          .prepare('UPDATE tasks SET evidence_status=? WHERE id=?')
          .run(evidenceProjection(ctx, c.taskId), c.taskId)
        break
      }
      case 'set_status': {
        if (task.intake !== 'accepted') throw new Error('TASK_NOT_ACCEPTED')
        if (!manual && c.status === 'cancelled')
          throw new Error('AUTOMATIC_CANCEL_DISABLED')
        if (
          !manual &&
          c.status === 'completed' &&
          (!ctx.allowAutoComplete ||
            evidenceProjection(ctx, c.taskId) !== 'sufficient')
        )
          throw new Error('COMPLETION_NOT_SUPPORTED')
        ctx.db
          .prepare('UPDATE tasks SET status=? WHERE id=?')
          .run(c.status, c.taskId)
        break
      }
      case 'set_due': {
        let effective = c.effectiveAt
        if (!manual) {
          if (c.originEventId === null) throw new Error('MISSING_PLAN_ORIGIN')
          const row = linkedEvent(ctx, c.taskId, c.originEventId, p),
            event = parseEventV2(JSON.parse(row.envelope))
          const occurred = event.sourceUpdatedAt ?? event.occurredAt
          if (
            row.current !== c.originEventId ||
            row.state !== 'current' ||
            event.payload.kind !== 'message' ||
            event.payload.role !== 'user' ||
            occurred === null ||
            Date.parse(effective) !== Date.parse(occurred)
          )
            throw new Error('INVALID_PLAN_ORIGIN')
          if (
            task.plan_effective_at &&
            Date.parse(effective) < Date.parse(task.plan_effective_at)
          )
            throw new Error('STALE_PLAN')
          if (task.plan_event_id) {
            const previous = ctx.db
              .prepare('SELECT source_id FROM source_events WHERE id=?')
              .get(task.plan_event_id) as { source_id: string }
            if (previous.source_id !== row.source_id)
              throw new Error('PLAN_SCOPE_CONFLICT')
          }
        } else effective = iso(ctx)
        ctx.db
          .prepare(
            'UPDATE tasks SET due_at=?,plan_effective_at=?,plan_event_id=? WHERE id=?',
          )
          .run(
            c.dueAt,
            new Date(effective).toISOString(),
            c.originEventId,
            c.taskId,
          )
        break
      }
    }
    ctx.fault('operation:command')
  }
  const decision = ctx.db
    .prepare(
      'INSERT INTO decisions(operation_id,actor,reason,policy_version,input_refs,proposal,created_at) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      operationId,
      actor,
      p.reason,
      p.policyVersion,
      JSON.stringify(p.inputs),
      JSON.stringify(p),
      iso(ctx),
    ).lastInsertRowid
  for (const id of ids) {
    const old = initial.get(id),
      nextVersion = (old?.version ?? 0) + 1,
      nextManual = (old?.manual_version ?? 0) + (manual ? 1 : 0)
    ctx.db
      .prepare(
        'UPDATE tasks SET version=?,manual_version=?,legacy=CASE WHEN intake IS NOT NULL THEN 0 ELSE legacy END,updated_at=? WHERE id=?',
      )
      .run(nextVersion, nextManual, iso(ctx), id)
    if (manual)
      for (const c of p.commands.filter(
        (c) =>
          c.taskId === id &&
          c.kind !== 'release_override' &&
          c.kind !== 'link_source',
      )) {
        ctx.db
          .prepare(
            'INSERT INTO manual_overrides VALUES(?,?,?,?,1) ON CONFLICT(task_id,field) DO UPDATE SET version=excluded.version,decision_id=excluded.decision_id,active=1',
          )
          .run(id, fields[c.kind], nextManual, decision)
      }
    ctx.db
      .prepare('INSERT INTO task_revisions VALUES(?,?,?,?)')
      .run(id, nextVersion, decision, JSON.stringify(getTask(ctx, id)))
    syncSearch(ctx, id)
  }
  const result: OperationResult = {
    operationId,
    taskIds: ids,
    changed: ids.length > 0,
  }
  if (ids.length)
    ctx.db
      .prepare('INSERT INTO notification_outbox VALUES(?,?,?,?)')
      .run(operationId, decision, 'pending', iso(ctx))
  ctx.db
    .prepare('INSERT INTO operation_commits VALUES(?,?,?,?)')
    .run(operationId, hash, JSON.stringify(result), iso(ctx))
  ctx.fault('operation:committed')
  return result
}

export function taskRepository(ctx: Context) {
  return {
    getTask: (id: string) => getTask(ctx, id),
    submitManual(
      operationId: string,
      proposal: unknown,
      actor = 'user',
    ): OperationResult {
      if (actor === 'automatic') throw new Error('INVALID_ACTOR')
      return ctx.db
        .transaction(() => applyOperation(ctx, operationId, proposal, actor))
        .immediate()
    },
    deleteTask(id: string, expectedVersion: number, actor: string): void {
      requireId(actor)
      if (actor === 'automatic') throw new Error('INVALID_ACTOR')
      ctx.guard()
      ctx.db
        .transaction(() => {
          const task = taskRow(ctx, id)
          if (!task || task.version !== expectedVersion)
            throw new Error('VERSION_CONFLICT')
          // Soft deletion retains the decision history; source-wide erasure belongs to Q05.
          const at = iso(ctx),
            operationId = 'delete:' + digest([id, expectedVersion]),
            snapshot = {
              ...getTask(ctx, id),
              version: task.version + 1,
              manualVersion: task.manual_version + 1,
              deletedAt: at,
            }
          const decision = ctx.db
            .prepare(
              'INSERT INTO decisions(operation_id,actor,reason,policy_version,input_refs,proposal,created_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(
              operationId,
              actor,
              '显式删除事项',
              'manual-v1',
              '[]',
              JSON.stringify({ id, expectedVersion }),
              at,
            ).lastInsertRowid
          ctx.db
            .prepare(
              'UPDATE tasks SET deleted_at=?,version=version+1,manual_version=manual_version+1,updated_at=? WHERE id=?',
            )
            .run(at, at, id)
          ctx.db
            .prepare('INSERT INTO task_revisions VALUES(?,?,?,?)')
            .run(id, task.version + 1, decision, JSON.stringify(snapshot))
          ctx.db
            .prepare('INSERT INTO operation_commits VALUES(?,?,?,?)')
            .run(
              operationId,
              digest({ id, expectedVersion, actor }),
              JSON.stringify({ operationId, taskIds: [id], changed: true }),
              at,
            )
          ctx.db
            .prepare('INSERT INTO notification_outbox VALUES(?,?,?,?)')
            .run(operationId, decision, 'pending', at)
          syncSearch(ctx, id)
        })
        .immediate()
    },
  }
}

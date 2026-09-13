import { validateAssociationAudit } from './source-associations'
import { createPlanChanges } from './plan-changes'
import type Database from 'better-sqlite3'
import {
  parseSourceEvent,
  type TimelineEntry,
  type TimelineEvidence,
  type TimelinePage,
} from '@memo/contracts'
import { parseContextTimestamp, extractExplicitPlanChange } from '@memo/domain'
import { getSourceStatus } from './source-status'
import { createRetractions } from './retractions'
import {
  referenceAuditProjection,
  validateReferenceAudit,
} from './reference-audit'

function checkedAudit<T>(read: () => T): T {
  try {
    return read()
  } catch {
    return fail()
  }
}

type Row = Record<string, unknown>
type Position = { at: string; rank: number; id: number }
type Cursor = {
  v: 1 | 2
  projectId: string
  taskId: string
  ceil: number[]
  after: Position | null
}
export interface TimelineQuery {
  projectId: string
  taskId: string
  cursor?: string
  limit?: number
}
function fail(): never {
  throw Error('TIMELINE_CORRUPT_DATA')
}
function invalid(): never {
  throw Error('TIMELINE_INVALID_INPUT')
}
function str(v: unknown, max = 2048): string {
  if (typeof v !== 'string' || v.length > max || v.includes('\0')) fail()
  return v
}
function num(v: unknown, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) fail()
  return v
}
function one<T extends string>(v: unknown, values: readonly T[]): T {
  if (typeof v !== 'string' || !values.includes(v as T)) fail()
  return v as T
}
function date(v: unknown): string {
  const s = str(v, 40)
  if (!Number.isFinite(Date.parse(s)) || new Date(s).toISOString() !== s) fail()
  return s
}
function obj(v: unknown, keys?: string[], required = keys): Row {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail()
  const r = v as Row
  if (keys && Object.keys(r).some((k) => !keys.includes(k))) fail()
  if (required?.some((k) => !Object.hasOwn(r, k))) fail()
  return r
}
function json(v: unknown): unknown {
  const text = str(v, 65536)
  try {
    return JSON.parse(text)
  } catch {
    fail()
  }
}
function digest(v: unknown): string {
  const text = str(v, 64)
  if (!/^[0-9a-f]{64}$/.test(text)) fail()
  return text
}
const taskKeys = [
  'id',
  'projectId',
  'title',
  'owner',
  'status',
  'evidenceStatus',
  'admission',
  'version',
  'criteriaVersion',
  'manualVersion',
  'archivedAt',
  'dueAt',
]
const fields = [
  'title',
  'owner',
  'status',
  'admission',
  'evidenceStatus',
  'projectId',
  'archivedAt',
  'dueAt',
  'criteriaVersion',
  'manualVersion',
] as const
const families = [
  'manual',
  'rule',
  'reference_conflict',
  'reference_confirmation',
  'retraction',
  'source_binding',
  'plan_assessment',
] as const
/** All row enumeration stays in bounded SQL. Snapshot ceilings exclude even backdated concurrent inserts. */
export function createTimeline(db: Database.Database) {
  function event(projectId: string, eventId: unknown): TimelineEvidence {
    const id = num(eventId, 1)
    const r = db
      .prepare(
        'SELECT e.* FROM source_events e JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=? WHERE e.id=?',
      )
      .get(projectId, id) as Row | undefined
    if (!r) fail()
    let e
    try {
      e = parseSourceEvent({
        schemaVersion: 1,
        sourceInstanceId: r.source_id,
        externalId: r.external_id,
        revision: r.revision,
        role: r.role,
        text: r.content,
        occurredAt: r.occurred_at,
        operation: r.operation,
      })
      parseContextTimestamp(e.occurredAt)
    } catch {
      fail()
    }
    const chars = Array.from(e.text)
    return {
      eventId: id,
      sourceInstanceId: e.sourceInstanceId,
      externalId: e.externalId,
      revision: e.revision,
      role: e.role,
      operation: e.operation ?? 'upsert',
      occurredAt: e.occurredAt,
      receivedAt: date(r.received_at),
      excerpt: chars.slice(0, 1024).join(''),
      excerptTruncated: chars.length > 1024,
      sourceStatus: getSourceStatus(db, projectId, e.sourceInstanceId),
    }
  }
  function reference(
    projectId: string,
    taskId: string,
    kind: unknown,
    id: unknown,
  ) {
    const k = one(kind, ['processing', 'manual'] as const),
      ref = str(id, 256)
    const table = k === 'processing' ? 'processing_evidence' : 'evidence_links'
    const r = db
      .prepare(
        `SELECT event_id AS eventId FROM ${table} WHERE project_id=? AND task_id=? AND CAST(id AS TEXT)=?`,
      )
      .get(projectId, taskId, ref) as Row | undefined
    if (!r) fail()
    return { kind: k, id: ref, event: event(projectId, r.eventId) }
  }
  function sameObject(a: TimelineEvidence, b: TimelineEvidence) {
    if (
      a.sourceInstanceId !== b.sourceInstanceId ||
      a.externalId !== b.externalId
    )
      fail()
  }
  function snapshot(
    raw: unknown,
    projectId: string,
    taskId: string,
    version: number,
  ): Row {
    const r = obj(
      json(raw),
      taskKeys,
      taskKeys.filter((k) => k !== 'dueAt'),
    )
    if (
      r.id !== taskId ||
      (r.projectId !== null && r.projectId !== projectId) ||
      num(r.version, 1) !== version
    )
      fail()
    str(r.title, 512)
    if (r.owner !== null) str(r.owner, 256)
    one(r.status, ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'])
    one(r.admission, ['candidate', 'accepted', 'ignored'])
    one(r.evidenceStatus, ['unknown', 'partial', 'sufficient', 'conflict'])
    num(r.criteriaVersion)
    num(r.manualVersion)
    if (r.archivedAt !== null) date(r.archivedAt)
    if (r.dueAt !== undefined && r.dueAt !== null) date(r.dueAt)
    return r
  }
  function criteria(
    projectId: string,
    taskId: string,
    version: number,
  ): string | null {
    if (!version) return null
    if (
      !db
        .prepare('SELECT 1 FROM criterion_sets WHERE task_id=? AND version=?')
        .get(taskId, version)
    )
      fail()
    const rows = db
      .prepare(
        'SELECT criterion_id,description,origin_event_id FROM criteria WHERE task_id=? AND project_id=? AND version=? ORDER BY criterion_id LIMIT 33',
      )
      .all(taskId, projectId, version) as Row[]
    if (rows.length > 32) fail()
    let chars = 0
    return rows
      .map((r) => {
        const id = str(r.criterion_id, 256),
          desc = str(r.description, 512)
        chars += desc.length + 1
        if (chars > 16384) fail()
        if (r.origin_event_id !== null) event(projectId, r.origin_event_id)
        return `${id}: ${desc}`
      })
      .join('\n')
  }
  function manual(
    rowId: number,
    projectId: string,
    taskId: string,
    base: TimelineEntry,
  ): TimelineEntry {
    const r = db
      .prepare(
        'SELECT d.*,r.snapshot,r.decision_id AS revisionDecision FROM decisions d LEFT JOIN task_revisions r ON r.task_id=d.task_id AND r.version=d.task_version WHERE d.id=? AND d.task_id=?',
      )
      .get(rowId, taskId) as Row | undefined
    if (!r || r.actor !== 'manual' || r.revisionDecision !== rowId) fail()
    const version = num(r.task_version, 1),
      after = snapshot(r.snapshot, projectId, taskId, version)
    if (after.projectId !== projectId) fail()
    if (
      num(r.criteria_version) !== after.criteriaVersion ||
      num(r.manual_version) !== after.manualVersion
    )
      fail()
    const previous = db
      .prepare(
        'SELECT snapshot FROM task_revisions WHERE task_id=? AND version=?',
      )
      .get(taskId, version - 1) as Row | undefined
    if (!previous && version !== 1) fail()
    const before = previous
      ? snapshot(previous.snapshot, projectId, taskId, version - 1)
      : null
    const inputRefs = json(r.input_refs)
    if (!Array.isArray(inputRefs) || inputRefs.length > 32) fail()
    const refs = inputRefs.map((x) => num(x, 1))
    for (const id of refs) event(projectId, id)
    const changes: TimelineEntry['changes'] = []
    for (const field of fields) {
      const a = after[field] ?? null,
        b = before?.[field] ?? null
      if (a !== b)
        changes.push({
          field,
          before: b === null ? null : String(b),
          after: a === null ? null : String(a),
        })
    }
    const scope = str(r.scope, 512),
      payload = json(r.payload)
    if (scope !== 'criteria' && !scope.startsWith('evidence:') && refs.length) {
      if (scope !== 'dueAt' || refs.length !== 1 || !before) fail()
      const plans = db
        .prepare(
          `SELECT p.*,e.content,e.role,e.operation
        FROM plan_change_proposals p JOIN source_events e ON e.id=p.event_id
        WHERE p.project_id=? AND p.task_id=? AND p.decision_id=? LIMIT 2`,
        )
        .all(projectId, taskId, rowId) as Row[]
      if (plans.length !== 1) fail()
      const plan = plans[0]!
      if (
        plan.event_id !== refs[0] ||
        plan.due_at !== after.dueAt ||
        num(plan.task_version, 1) !== before.version ||
        num(plan.criteria_version) !== before.criteriaVersion ||
        num(plan.manual_version) !== before.manualVersion
      )
        fail()
      date(plan.created_at)
      date(plan.applied_at)
      event(projectId, plan.baseline_event_id)
      const extracted = extractExplicitPlanChange({
        text: str(plan.content, 65536),
        role: one(plan.role, ['user', 'assistant', 'tool', 'system']),
        operation: one(plan.operation, ['upsert', 'retract'] as const),
      })
      if (
        !extracted ||
        extracted.quote !== plan.quote ||
        extracted.dueAt !== plan.due_at
      )
        fail()
    }
    let ref: TimelineEntry['reference'] = null
    if (scope === 'criteria') {
      if (!Array.isArray(payload) || payload.length > 32) fail()
      const ids = new Set<string>(),
        expectedRefs: number[] = []
      for (const value of payload) {
        const c = obj(
          value,
          ['id', 'description', 'originEventId'],
          ['id', 'description'],
        )
        const id = str(c.id, 256)
        if (ids.has(id)) fail()
        ids.add(id)
        str(c.description, 512)
        const stored = db
          .prepare(
            'SELECT description,origin_event_id FROM criteria WHERE task_id=? AND project_id=? AND version=? AND criterion_id=?',
          )
          .get(taskId, projectId, after.criteriaVersion, id) as Row | undefined
        if (
          !stored ||
          stored.description !== c.description ||
          stored.origin_event_id !== (c.originEventId ?? null)
        )
          fail()
        if (c.originEventId !== undefined)
          expectedRefs.push(num(c.originEventId, 1))
        if (
          c.originEventId !== undefined &&
          !refs.includes(num(c.originEventId, 1))
        )
          fail()
      }
      if (JSON.stringify(expectedRefs) !== JSON.stringify(refs)) fail()
      const count = db
        .prepare(
          'SELECT count(*) AS n FROM criteria WHERE task_id=? AND project_id=? AND version=?',
        )
        .get(taskId, projectId, after.criteriaVersion) as Row
      if (count.n !== payload.length) fail()
      changes.push({
        field: 'criteria',
        before: criteria(projectId, taskId, num(before?.criteriaVersion ?? 0)),
        after: criteria(projectId, taskId, num(after.criteriaVersion)),
      })
    } else if (scope.startsWith('evidence:')) {
      const p = obj(payload, [
        'id',
        'criterionId',
        'criteriaVersion',
        'eventId',
        'relation',
        'validity',
        'reason',
      ])
      str(p.criterionId, 256)
      num(p.criteriaVersion, 1)
      str(p.reason, 2048)
      if (
        scope !== `evidence:${str(p.id, 256)}` ||
        refs.length !== 1 ||
        refs[0] !== num(p.eventId, 1)
      )
        fail()
      const target = reference(projectId, taskId, 'manual', p.id)
      if (target.event.eventId !== p.eventId) fail()
      ref = { kind: 'manual', id: target.id, version: null }
      changes.push(
        {
          field: 'evidenceRelation',
          before: null,
          after: one(p.relation, ['supports', 'opposes', 'related']),
        },
        {
          field: 'evidenceValidity',
          before: null,
          after: one(p.validity, ['valid', 'unknown', 'invalid']),
        },
      )
    } else if (scope === 'merge') {
      const p = obj(payload, ['sourceId', 'targetId'])
      const merge = db
        .prepare(
          'SELECT * FROM task_merges WHERE source_id=? AND target_id=? AND project_id=?',
        )
        .get(str(p.sourceId, 256), str(p.targetId, 256), projectId) as
        | Row
        | undefined
      if (
        !merge ||
        !before ||
        ![p.sourceId, p.targetId].includes(taskId) ||
        version !==
          (taskId === p.sourceId ? merge.source_version : merge.target_version)
      )
        fail()
      changes.push({
        field: 'merge',
        before: str(p.sourceId, 256),
        after: str(p.targetId, 256),
      })
      if (taskId === p.targetId)
        changes.push({
          field: 'criteria',
          before: criteria(projectId, taskId, num(before.criteriaVersion)),
          after: criteria(projectId, taskId, num(after.criteriaVersion)),
        })
    } else if (scope === 'create') {
      const p = obj(payload, ['title'])
      if (p.title !== after.title || before) fail()
    } else if (scope === 'project') {
      const p = obj(payload, ['projectId'])
      if (p.projectId !== projectId || before?.projectId !== null) fail()
    } else {
      const keys = scope.split(',')
      if (
        !keys.length ||
        keys.some(
          (k) =>
            ![
              'title',
              'owner',
              'status',
              'admission',
              'archived',
              'dueAt',
            ].includes(k),
        )
      )
        fail()
      const p = obj(payload, keys)
      for (const key of keys) {
        if (key === 'archived') {
          if (
            typeof p.archived !== 'boolean' ||
            p.archived !== (after.archivedAt !== null)
          )
            fail()
        } else if (key === 'dueAt' && p[key] !== null) {
          const raw = str(p[key], 32)
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(raw))
            fail()
          const padded = raw.replace(
            /(?:\.(\d{1,3}))?Z$/,
            (_, fraction: string | undefined) =>
              `.${(fraction ?? '').padEnd(3, '0')}Z`,
          )
          if (date(padded) !== after.dueAt) fail()
        } else if (p[key] !== after[key]) fail()
      }
    }
    return {
      ...base,
      actor: { kind: 'manual', id: str(r.actor_id, 256) },
      reason: str(r.reason, 2048),
      taskVersion: version,
      reference: ref,
      changes,
      relatedEventIds: refs,
      evidence: refs.length ? event(projectId, refs[0]) : null,
    }
  }
  function projectEntry(
    position: Position,
    projectId: string,
    taskId: string,
  ): TimelineEntry {
    const rank = num(position.rank),
      rowId = num(position.id, 1)
    if (rank > 6) fail()
    const base: TimelineEntry = {
      key: `${families[rank]}:${rowId}`,
      kind: families[rank]!,
      recordedAt: date(position.at),
      timeBasis: 'recorded',
      actor: { kind: 'system', id: null },
      reason: '',
      taskVersion: null,
      reference: null,
      changes: [],
      relatedEventIds: [],
      evidence: null,
    }
    if (rank === 0) return manual(rowId, projectId, taskId, base)
    if (rank === 5) {
      const row = db
        .prepare(
          'SELECT * FROM source_association_audit WHERE id=? AND project_id=?',
        )
        .get(rowId, projectId)
      if (!row) fail()
      const audit = checkedAudit(() => validateAssociationAudit(db, row))
      if (
        audit.id !== rowId ||
        audit.projectId !== projectId ||
        (audit.taskId !== taskId &&
          !(
            audit.kind === 'identity_mapping' && audit.after.taskId === taskId
          )) ||
        audit.recordedAt !== base.recordedAt
      )
        fail()
      const eventIds = [
        ...new Set(
          [audit.before, audit.after].flatMap((snapshot) =>
            !snapshot
              ? []
              : 'baselineEventId' in snapshot
                ? [snapshot.baselineEventId]
                : [snapshot.leftEventId, snapshot.rightEventId],
          ),
        ),
      ]
      eventIds.forEach((id) => event(projectId, id))
      return {
        ...base,
        kind: audit.kind,
        actor: { kind: 'manual', id: str(audit.actorId, 256) },
        reason: str(audit.reason, 512),
        relatedEventIds: eventIds,
        evidence: eventIds.length ? event(projectId, eventIds[0]) : null,
        changes: [
          {
            field:
              audit.kind === 'source_binding'
                ? 'bindingStatus'
                : 'mappingStatus',
            before: audit.before
              ? audit.before.active
                ? 'active'
                : 'revoked'
              : null,
            after: audit.after.active ? 'active' : 'revoked',
          },
          {
            field: 'associationVersion',
            before: audit.before ? String(audit.before.version) : null,
            after: String(audit.version),
          },
        ],
      }
    }
    if (rank === 6) {
      const audit = checkedAudit(() =>
        createPlanChanges(db).getAudit(projectId, taskId, rowId),
      )
      if (audit.id !== rowId || audit.recordedAt !== base.recordedAt) fail()
      audit.eventIds.forEach((id) => event(projectId, id))
      return {
        ...base,
        actor: { kind: audit.actorKind, id: str(audit.actorId, 256) },
        reason: str(audit.reason, 512),
        taskVersion: audit.after.taskVersion,
        relatedEventIds: audit.eventIds,
        evidence: audit.eventIds.length
          ? event(projectId, audit.eventIds[0])
          : null,
        changes: [
          {
            field: 'assessmentVersion',
            before: audit.before
              ? String(audit.before.assessmentVersion)
              : null,
            after: String(audit.after.assessmentVersion),
          },
          {
            field: 'baselineEventId',
            before: audit.before ? String(audit.before.baselineEventId) : null,
            after: String(audit.after.baselineEventId),
          },
          {
            field: 'proposalTaskVersion',
            before: audit.before ? String(audit.before.taskVersion) : null,
            after: String(audit.after.taskVersion),
          },
        ],
      }
    }
    if (rank === 1) {
      const r = db
        .prepare(
          'SELECT d.*,r.rule_version,r.outcome AS resultOutcome,r.reason AS resultReason,r.project_id AS resultProject FROM processing_decisions d LEFT JOIN processing_results r ON r.event_id=d.event_id WHERE d.id=? AND d.project_id=? AND d.task_id=?',
        )
        .get(rowId, projectId, taskId) as Row | undefined
      if (
        !r ||
        r.actor !== 'rule' ||
        r.resultProject !== projectId ||
        r.resultOutcome !== r.outcome ||
        r.resultReason !== r.reason ||
        !['explicit-commitment-v1', 'explicit-commitment-v2'].includes(
          String(r.rule_version),
        )
      )
        fail()
      one(r.outcome, ['created', 'review_required'])
      const reason = one(r.reason, [
        'explicit_commitment',
        'plan_change',
        'candidate_limit',
        'source_revision_requires_review',
        'source_retracted',
        'source_object_retracted',
      ])
      return {
        ...base,
        actor: { kind: 'rule', id: String(r.rule_version) },
        reason,
        relatedEventIds: [num(r.event_id, 1)],
        evidence: event(projectId, r.event_id),
      }
    }
    if (rank === 2) {
      const r = db
        .prepare(
          `SELECT *,${referenceAuditProjection} FROM reference_revision_audit WHERE id=? AND project_id=? AND task_id=?`,
        )
        .get(rowId, projectId, taskId) as Row | undefined
      if (!r) fail()
      try {
        validateReferenceAudit(db, r)
      } catch {
        fail()
      }
      const origin = one(r.origin, ['observed', 'migration_snapshot']),
        ref = reference(projectId, taskId, r.ref_kind, r.ref_id)
      const previous =
        r.previous_status === null
          ? null
          : one(r.previous_status, [
              'available',
              'review_required',
              'confirmed',
            ])
      if (r.new_status !== 'review_required') fail()
      const before =
          r.previous_digest === null ? null : digest(r.previous_digest),
        after = digest(r.new_digest)
      if (
        origin === 'migration_snapshot' &&
        (r.trigger_event_id !== null || previous !== null || before !== null)
      )
        fail()
      const proof =
        r.trigger_event_id === null
          ? null
          : event(projectId, r.trigger_event_id)
      if (origin === 'observed' && !proof) fail()
      if (proof) {
        sameObject(ref.event, proof)
        if (proof.operation !== 'upsert') fail()
      }
      return {
        ...base,
        timeBasis:
          origin === 'migration_snapshot' ? 'migration_snapshot' : 'recorded',
        reason:
          origin === 'migration_snapshot'
            ? 'existing_conflict_snapshot'
            : 'known_content_changed',
        reference: {
          kind: ref.kind,
          id: ref.id,
          version: num(r.reference_version, 1),
        },
        changes: [
          {
            field: 'referenceStatus',
            before: previous,
            after: 'review_required',
          },
          { field: 'contentDigest', before, after },
        ],
        relatedEventIds: proof ? [proof.eventId] : [],
        evidence: proof,
      }
    }
    if (rank === 3) {
      const r = db
        .prepare(
          'SELECT * FROM reference_revision_decisions WHERE id=? AND project_id=? AND task_id=?',
        )
        .get(rowId, projectId, taskId) as Row | undefined
      if (!r) fail()
      const ref = reference(
          projectId,
          taskId,
          r.reference_kind,
          r.reference_id,
        ),
        proof = event(projectId, r.chosen_event_id)
      sameObject(ref.event, proof)
      if (proof.operation !== 'upsert') fail()
      digest(r.content_digest)
      return {
        ...base,
        actor: { kind: 'manual', id: str(r.actor_id, 256) },
        reason: str(r.reason, 512),
        reference: {
          kind: ref.kind,
          id: ref.id,
          version: num(r.reference_version, 1),
        },
        changes: [
          {
            field: 'confirmedEventId',
            before: null,
            after: String(proof.eventId),
          },
        ],
        relatedEventIds: [proof.eventId],
        evidence: proof,
      }
    }
    const r = db
      .prepare(
        'SELECT * FROM retraction_impacts WHERE rowid=? AND project_id=?',
      )
      .get(rowId, projectId) as Row | undefined
    if (!r) fail()
    const ref = reference(projectId, taskId, r.kind, r.evidence_id),
      proof = event(projectId, r.retraction_event_id)
    sameObject(ref.event, proof)
    if (
      proof.operation !== 'retract' ||
      createRetractions(db).forEvent(projectId, ref.event.eventId)?.eventId !==
        proof.eventId
    )
      fail()
    const before =
      ref.kind === 'processing'
        ? one(r.prior_validity, ['available', 'invalidated'])
        : one(r.prior_validity, ['valid', 'unknown', 'invalid'])
    return {
      ...base,
      timeBasis: 'event_received',
      reason: 'explicit_source_retraction',
      reference: { kind: ref.kind, id: ref.id, version: null },
      changes: [{ field: 'referenceStatus', before, after: 'invalidated' }],
      relatedEventIds: [proof.eventId],
      evidence: proof,
    }
  }
  const tables = [
    'decisions',
    'processing_decisions',
    'reference_revision_audit',
    'reference_revision_decisions',
    'retraction_impacts',
    'source_association_audit',
    'plan_change_assessments',
  ]
  const union = `SELECT d.id AS id,0 AS rank,d.created_at AS at FROM decisions d WHERE d.task_id=@task AND d.id<=@c0
 UNION ALL SELECT d.id,1,d.created_at FROM processing_decisions d WHERE d.project_id=@project AND d.task_id=@task AND d.id<=@c1
 UNION ALL SELECT d.id,2,d.recorded_at FROM reference_revision_audit d WHERE d.project_id=@project AND d.task_id=@task AND d.id<=@c2
 UNION ALL SELECT d.id,3,d.created_at FROM reference_revision_decisions d WHERE d.project_id=@project AND d.task_id=@task AND d.id<=@c3
 UNION ALL SELECT i.rowid,4,e.received_at FROM retraction_impacts i LEFT JOIN source_events e ON e.id=i.retraction_event_id WHERE i.project_id=@project AND i.rowid<=@c4 AND ((i.kind='processing' AND EXISTS(SELECT 1 FROM processing_evidence p WHERE CAST(p.id AS TEXT)=i.evidence_id AND p.project_id=@project AND p.task_id=@task)) OR (i.kind='manual' AND EXISTS(SELECT 1 FROM evidence_links p WHERE p.id=i.evidence_id AND p.project_id=@project AND p.task_id=@task)))
 UNION ALL SELECT a.id,5,a.recorded_at FROM source_association_audit a WHERE a.project_id=@project AND a.id<=@c5 AND (a.task_id=@task OR (a.kind='identity_mapping' AND EXISTS(SELECT 1 FROM explicit_identity_mappings m WHERE m.id=a.entity_id AND m.project_id=@project AND m.task_id=@task)))
 UNION ALL SELECT a.id,6,a.recorded_at FROM plan_change_assessments a WHERE a.project_id=@project AND a.task_id=@task AND a.id<=@c6`
  return {
    list: db.transaction((input: TimelineQuery): TimelinePage => {
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).some(
          (k) => !['projectId', 'taskId', 'cursor', 'limit'].includes(k),
        ) ||
        [input.projectId, input.taskId].some(
          (v) =>
            typeof v !== 'string' ||
            v.length < 1 ||
            v.length > 256 ||
            /\s|[\u0000-\u001f\u007f]/u.test(v),
        ) ||
        !Number.isSafeInteger(input.limit ?? 20) ||
        (input.limit ?? 20) < 1 ||
        (input.limit ?? 20) > 50
      )
        invalid()
      const projectId = input.projectId,
        taskId = input.taskId,
        limit = input.limit ?? 20
      if (
        !db
          .prepare('SELECT 1 FROM tasks WHERE id=? AND project_id=?')
          .get(taskId, projectId)
      )
        throw Error('NOT_FOUND')
      let state: Cursor
      if (input.cursor !== undefined) {
        try {
          if (
            typeof input.cursor !== 'string' ||
            input.cursor.length > 4096 ||
            !/^[A-Za-z0-9_-]+$/.test(input.cursor)
          )
            invalid()
          const parsed = obj(
            JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')),
            ['v', 'projectId', 'taskId', 'ceil', 'after'],
          )
          if (
            ![1, 2].includes(parsed.v as number) ||
            parsed.projectId !== projectId ||
            parsed.taskId !== taskId ||
            !Array.isArray(parsed.ceil) ||
            parsed.ceil.length !== (parsed.v === 1 ? 5 : 7)
          )
            invalid()
          parsed.ceil.forEach((x) => num(x))
          if (parsed.after === null) invalid()
          const after = obj(parsed.after, ['at', 'rank', 'id'])
          date(after.at)
          if (num(after.rank) > (parsed.v === 1 ? 4 : 6)) invalid()
          num(after.id, 1)
          state = parsed as unknown as Cursor
        } catch {
          throw Error('TIMELINE_INVALID_CURSOR')
        }
      } else
        state = {
          v: 2,
          projectId,
          taskId,
          ceil: tables.map((table) =>
            num(
              (
                db
                  .prepare(`SELECT coalesce(max(rowid),0) AS n FROM ${table}`)
                  .get() as Row
              ).n,
            ),
          ),
          after: null,
        }
      const params = {
        project: projectId,
        task: taskId,
        c0: state.ceil[0]!,
        c1: state.ceil[1]!,
        c2: state.ceil[2]!,
        c3: state.ceil[3]!,
        c4: state.ceil[4]!,
        c5: state.ceil[5] ?? 0,
        c6: state.ceil[6] ?? 0,
        at: state.after?.at ?? '',
        rank: state.after?.rank ?? 0,
        id: state.after?.id ?? 0,
        limit: limit + 1,
      }
      const query = `WITH history AS (${union}) SELECT id,rank,at FROM history ${state.after ? 'WHERE (at,rank,id)<(@at,@rank,@id)' : ''} ORDER BY at DESC,rank DESC,id DESC LIMIT @limit`
      // better-sqlite permits unused named bindings; SQL identifiers above are constants only.
      const positions = db.prepare(query).all(params) as Position[]
      const entries: TimelineEntry[] = []
      let bytes = 128,
        last: Position | undefined,
        more = false
      for (const pos of positions) {
        date(pos.at)
        num(pos.rank)
        num(pos.id, 1)
        if (entries.length === limit) {
          more = true
          break
        }
        const entry = projectEntry(pos, projectId, taskId)
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1
        if (bytes + size > 500 * 1024) {
          if (!entries.length) fail()
          more = true
          break
        }
        entries.push(entry)
        bytes += size
        last = pos
      }
      const nextCursor =
        more && last
          ? Buffer.from(JSON.stringify({ ...state, after: last })).toString(
              'base64url',
            )
          : null
      if (
        Buffer.byteLength(JSON.stringify({ entries, nextCursor })) >
        512 * 1024
      )
        fail()
      return { entries, nextCursor }
    }),
  }
}

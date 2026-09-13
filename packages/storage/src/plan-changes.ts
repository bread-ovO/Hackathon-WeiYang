import { createSourceAssociations } from './source-associations'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
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
  assessmentVersion: number
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
    | 'association_changed'
    | 'mapping_changed'
  sourceStatus: CurrentSourceStatus
  taskVersion: number
  criteriaVersion: number
  manualVersion: number
  appliedAt: string | null
}
type Row = {
  assessment_version: number
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
export function migratePlanAssessments(db: Database.Database) {
  db.transaction(() =>
    db.exec(`ALTER TABLE plan_change_proposals ADD COLUMN assessment_version INTEGER NOT NULL DEFAULT 0 CHECK(assessment_version>=0);
 CREATE TABLE plan_change_assessments(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL,task_id TEXT NOT NULL,proposal_id INTEGER NOT NULL REFERENCES plan_change_proposals(id),version INTEGER NOT NULL CHECK(version>=1),recorded_at TEXT NOT NULL,actor_id TEXT NOT NULL,actor_kind TEXT NOT NULL CHECK(actor_kind IN('manual','rule')),reason TEXT NOT NULL,before_snapshot TEXT,after_snapshot TEXT NOT NULL,proof TEXT NOT NULL,UNIQUE(proposal_id,version),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
 CREATE INDEX plan_assessment_scope ON plan_change_assessments(project_id,task_id,id);
 PRAGMA user_version=18;`),
  )()
}
type AssessmentSnapshot = {
  baselineEventId: number
  taskVersion: number
  criteriaVersion: number
  manualVersion: number
  assessmentVersion: number
}
type AssessmentProof = {
  bindings: { id: string; version: number; eventId: number }[]
  authorLinks: {
    leftEventId: number
    rightEventId: number
    matched: boolean
    mappingId: string | null
    mappingVersion: number | null
  }[]
  currentEventId: number
}
export interface PlanAssessmentAudit {
  id: number
  proposalId: number
  version: number
  recordedAt: string
  actorId: string
  actorKind: 'manual' | 'rule'
  reason: string
  before: AssessmentSnapshot | null
  after: AssessmentSnapshot
  proof: AssessmentProof
  eventIds: number[]
}
export function createPlanChanges(db: Database.Database) {
  const tasks = createTaskModel(db)
  const associations = createSourceAssociations(db)
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
    const target =
      eventMetadataFields(e.metadata_json).metadata?.replyToExternalId ??
      e.external_id
    try {
      const binding = associations.resolveObject(project, e.source_id, target)
      return binding ? [{ task_id: binding.taskId }] : []
    } catch (error) {
      if (error instanceof Error && error.message === 'ASSOCIATION_CONFLICT')
        return []
      throw error
    }
  }
  function baseline(project: string, taskId: string) {
    const value = associations.primaryEventId(project, taskId)
    return value === null ? undefined : { id: value }
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
        eventId: createHash('sha256')
          .update(JSON.stringify([current.source_id, current.external_id]))
          .digest('hex'),
        revision: current.revision,
        time: {
          occurredAt: current.occurred_at,
          receivedAt: current.received_at,
        },
        planFingerprint: currentDue ?? 'no-deadline',
      },
      {
        identity,
        eventId: createHash('sha256')
          .update(JSON.stringify([incoming.source_id, incoming.external_id]))
          .digest('hex'),
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
    ;[row.criteria_version, row.manual_version, row.assessment_version].forEach(
      (value) => number(value),
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
  function snapshot(row: Row): AssessmentSnapshot {
    return {
      baselineEventId: row.baseline_event_id,
      taskVersion: row.task_version,
      criteriaVersion: row.criteria_version,
      manualVersion: row.manual_version,
      assessmentVersion: row.assessment_version,
    }
  }
  function makeProof(
    projectId: string,
    taskId: string,
    e: Event,
    original: Event,
  ): AssessmentProof {
    const target =
      eventMetadataFields(e.metadata_json).metadata?.replyToExternalId ??
      e.external_id
    const incomingBinding = associations.resolveObject(
        projectId,
        e.source_id,
        target,
      ),
      primaryBinding = associations.resolveObject(
        projectId,
        original.source_id,
        original.external_id,
      )
    if (
      !incomingBinding ||
      !primaryBinding ||
      incomingBinding.taskId !== taskId ||
      primaryBinding.taskId !== taskId
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    const latest = db
      .prepare(
        'SELECT * FROM plan_change_proposals WHERE project_id=? AND task_id=? AND applied_at IS NOT NULL ORDER BY decision_id DESC LIMIT 1',
      )
      .get(projectId, taskId) as Row | undefined
    if (latest) validateRow(latest)
    const current = latest ? event(projectId, latest.event_id) : original
    const currentBinding =
      current.id === original.id
        ? primaryBinding
        : associations.resolveObject(
            projectId,
            current.source_id,
            eventMetadataFields(current.metadata_json).metadata
              ?.replyToExternalId ?? current.external_id,
          )
    if (!currentBinding || currentBinding.taskId !== taskId)
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    const authorLinks = [...new Set([original.id, current.id])].map(
      (leftEventId) => ({
        leftEventId,
        rightEventId: e.id,
        ...associations.matchAuthors(projectId, leftEventId, e.id),
      }),
    )
    return {
      bindings: [
        {
          id: incomingBinding.id,
          version: incomingBinding.version,
          eventId: e.id,
        },
        {
          id: primaryBinding.id,
          version: primaryBinding.version,
          eventId: original.id,
        },
        ...(current.id === original.id
          ? []
          : [
              {
                id: currentBinding.id,
                version: currentBinding.version,
                eventId: current.id,
              },
            ]),
      ],
      authorLinks,
      currentEventId: current.id,
    }
  }
  function readAudit(
    projectId: string,
    taskId: string,
    auditId: number,
  ): PlanAssessmentAudit {
    scope(projectId, taskId)
    number(auditId, 1)
    const r = db
      .prepare(
        'SELECT * FROM plan_change_assessments WHERE id=? AND project_id=? AND task_id=?',
      )
      .get(auditId, projectId, taskId) as
      | {
          id: number
          proposal_id: number
          version: number
          recorded_at: string
          actor_id: string
          actor_kind: 'manual' | 'rule'
          reason: string
          before_snapshot: string | null
          after_snapshot: string
          proof: string
        }
      | undefined
    if (!r) throw Error('PLAN_CHANGE_NOT_FOUND')
    const proposal = db
      .prepare(
        'SELECT * FROM plan_change_proposals WHERE id=? AND project_id=? AND task_id=?',
      )
      .get(r.proposal_id, projectId, taskId) as Row | undefined
    if (!proposal) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    validateRow(proposal)
    const before =
        r.before_snapshot === null
          ? null
          : (JSON.parse(r.before_snapshot) as AssessmentSnapshot),
      after = JSON.parse(r.after_snapshot) as AssessmentSnapshot,
      proof = JSON.parse(r.proof) as AssessmentProof
    number(r.version, 1)
    id(r.actor_id)
    if (
      !['manual', 'rule'].includes(r.actor_kind) ||
      (r.actor_kind === 'rule' && r.actor_id !== 'explicit-plan-change-v1') ||
      (r.actor_kind === 'manual' && r.actor_id === 'explicit-plan-change-v1')
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    if (
      typeof r.reason !== 'string' ||
      !r.reason.length ||
      r.reason.length > 512 ||
      new Date(r.recorded_at).toISOString() !== r.recorded_at
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    for (const value of [before, after])
      if (value) {
        if (
          Object.keys(value).sort().join(',') !==
          'assessmentVersion,baselineEventId,criteriaVersion,manualVersion,taskVersion'
        )
          throw Error('PLAN_CHANGE_NOT_APPLICABLE')
        number(value.baselineEventId, 1)
        number(value.taskVersion, 1)
        number(value.criteriaVersion)
        number(value.manualVersion)
        number(value.assessmentVersion)
        event(projectId, value.baselineEventId)
        const revision = db
          .prepare(
            'SELECT snapshot FROM task_revisions WHERE task_id=? AND version=?',
          )
          .get(taskId, value.taskVersion) as { snapshot: string } | undefined
        if (!revision) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
        const stored = JSON.parse(revision.snapshot)
        if (
          stored.id !== taskId ||
          stored.projectId !== projectId ||
          stored.criteriaVersion !== value.criteriaVersion ||
          stored.manualVersion !== value.manualVersion
        )
          throw Error('PLAN_CHANGE_NOT_APPLICABLE')
        if (
          associations.primaryEventId(projectId, taskId) !==
          value.baselineEventId
        )
          throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      }
    if (
      after.assessmentVersion !== r.version ||
      (before && before.assessmentVersion !== r.version - 1)
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    if (
      !proof ||
      Object.keys(proof).sort().join(',') !==
        'authorLinks,bindings,currentEventId' ||
      !Array.isArray(proof.bindings) ||
      proof.bindings.length < 2 ||
      proof.bindings.length > 3 ||
      !Array.isArray(proof.authorLinks) ||
      proof.authorLinks.length < 1 ||
      proof.authorLinks.length > 2
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    const historicalCurrent = db
      .prepare(
        'SELECT * FROM plan_change_proposals WHERE project_id=? AND task_id=? AND applied_at IS NOT NULL AND task_version+1<=? ORDER BY decision_id DESC LIMIT 1',
      )
      .get(projectId, taskId, after.taskVersion) as Row | undefined
    if (historicalCurrent) validateRow(historicalCurrent)
    if (
      proof.currentEventId !==
      (historicalCurrent?.event_id ?? after.baselineEventId)
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    const bindings = associations.sourceBindings({ projectId, taskId }).bindings
    const authorizedVersion = (
      kind: 'source_binding' | 'identity_mapping',
      entityId: string,
      version: number,
    ) => {
      const stored = db
        .prepare(
          'SELECT id FROM source_association_audit WHERE project_id=? AND kind=? AND entity_id=? AND version=?',
        )
        .get(projectId, kind, entityId, version) as { id: number } | undefined
      if (!stored) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      const audit = associations.audit(stored.id)
      if (!audit.after.active) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    }
    const eventIds = new Set<number>([
      proposal.event_id,
      after.baselineEventId,
      proof.currentEventId,
    ])
    for (const [fenceIndex, fence] of proof.bindings.entries()) {
      if (Object.keys(fence).sort().join(',') !== 'eventId,id,version')
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      id(fence.id)
      number(fence.version, 1)
      number(fence.eventId, 1)
      const known = bindings.find((b) => b.id === fence.id),
        e = event(projectId, fence.eventId),
        target =
          fenceIndex === 1
            ? e.external_id
            : (eventMetadataFields(e.metadata_json).metadata
                ?.replyToExternalId ?? e.external_id)
      if (
        !known ||
        known.version < fence.version ||
        known.sourceInstanceId !== e.source_id ||
        known.externalId !== target
      )
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      if (known.origin === 'rule') {
        if (fence.version !== 1) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      } else authorizedVersion('source_binding', fence.id, fence.version)
      eventIds.add(e.id)
    }
    if (
      proof.bindings[0]!.eventId !== proposal.event_id ||
      proof.bindings[1]!.eventId !== after.baselineEventId ||
      (proof.currentEventId === after.baselineEventId
        ? proof.bindings.length !== 2
        : proof.bindings.length !== 3 ||
          proof.bindings[2]!.eventId !== proof.currentEventId)
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    for (const link of proof.authorLinks) {
      if (
        Object.keys(link).sort().join(',') !==
          'leftEventId,mappingId,mappingVersion,matched,rightEventId' ||
        typeof link.matched !== 'boolean' ||
        link.rightEventId !== proposal.event_id ||
        ![after.baselineEventId, proof.currentEventId].includes(
          link.leftEventId,
        )
      )
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      eventIds.add(link.leftEventId)
      eventIds.add(link.rightEventId)
      if ((link.mappingId === null) !== (link.mappingVersion === null))
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      if (link.mappingId === null && link.matched) {
        const l = event(projectId, link.leftEventId),
          r = event(projectId, link.rightEventId),
          la = eventMetadataFields(l.metadata_json).metadata?.author,
          ra = eventMetadataFields(r.metadata_json).metadata?.author
        if (
          l.source_id !== r.source_id ||
          !la ||
          !ra ||
          la.namespace !== ra.namespace ||
          la.subjectId !== ra.subjectId
        )
          throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      }
      if (link.mappingId !== null) {
        id(link.mappingId)
        number(link.mappingVersion, 1)
        if (!link.matched) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
        authorizedVersion(
          'identity_mapping',
          link.mappingId,
          link.mappingVersion!,
        )
        const known = associations
          .identityMappings({ projectId, taskId })
          .mappings.find((m) => m.id === link.mappingId)
        const left = event(projectId, link.leftEventId),
          right = event(projectId, link.rightEventId),
          la = eventMetadataFields(left.metadata_json).metadata?.author,
          ra = eventMetadataFields(right.metadata_json).metadata?.author
        const key = (
          source: string,
          author: { namespace: string; subjectId: string } | undefined,
        ) => JSON.stringify([source, author?.namespace, author?.subjectId])
        if (
          !known ||
          known.version < link.mappingVersion! ||
          !la ||
          !ra ||
          !(
            (key(known.left.sourceInstanceId, known.left) ===
              key(left.source_id, la) &&
              key(known.right.sourceInstanceId, known.right) ===
                key(right.source_id, ra)) ||
            (key(known.left.sourceInstanceId, known.left) ===
              key(right.source_id, ra) &&
              key(known.right.sourceInstanceId, known.right) ===
                key(left.source_id, la))
          )
        )
          throw Error('PLAN_CHANGE_NOT_APPLICABLE')
      }
    }
    if (
      new Set(proof.authorLinks.map((x) => x.leftEventId)).size !==
      new Set([after.baselineEventId, proof.currentEventId]).size
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    if (r.version > 1) {
      const previous = db
        .prepare(
          'SELECT after_snapshot FROM plan_change_assessments WHERE proposal_id=? AND version=?',
        )
        .get(r.proposal_id, r.version - 1) as
        | { after_snapshot: string }
        | undefined
      if (
        !previous ||
        JSON.stringify(before) !==
          JSON.stringify(JSON.parse(previous.after_snapshot))
      )
        throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    }
    for (const value of eventIds) {
      number(value, 1)
      event(projectId, value)
    }
    if (
      r.version === proposal.assessment_version &&
      JSON.stringify(after) !== JSON.stringify(snapshot(proposal))
    )
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    return {
      id: r.id,
      proposalId: r.proposal_id,
      version: r.version,
      recordedAt: r.recorded_at,
      actorId: r.actor_id,
      actorKind: r.actor_kind,
      reason: r.reason,
      before,
      after,
      proof,
      eventIds: [...eventIds],
    }
  }
  function latestAudit(row: Row) {
    if (row.assessment_version === 0) return null
    const counts = db
      .prepare(
        'SELECT COUNT(*) AS n FROM plan_change_assessments WHERE proposal_id=?',
      )
      .get(row.id) as { n: number }
    if (counts.n !== row.assessment_version)
      throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    const r = db
      .prepare(
        'SELECT id FROM plan_change_assessments WHERE proposal_id=? AND version=?',
      )
      .get(row.id, row.assessment_version) as { id: number } | undefined
    if (!r) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
    return readAudit(row.project_id, row.task_id, r.id)
  }
  function appendAssessment(
    row: Row,
    before: AssessmentSnapshot | null,
    proof: AssessmentProof,
    actorId: string,
    reason: string,
    now: Date,
    actorKind: 'manual' | 'rule',
  ) {
    db.prepare(
      'INSERT INTO plan_change_assessments(project_id,task_id,proposal_id,version,recorded_at,actor_id,actor_kind,reason,before_snapshot,after_snapshot,proof) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      row.project_id,
      row.task_id,
      row.id,
      row.assessment_version,
      now.toISOString(),
      actorId,
      actorKind,
      reason,
      before ? JSON.stringify(before) : null,
      JSON.stringify(snapshot(row)),
      JSON.stringify(proof),
    )
  }
  function project(row: Row): PlanChangeProposal {
    validateRow(row)
    const assessment = latestAudit(row)
    const task = scope(row.project_id, row.task_id),
      e = event(row.project_id, row.event_id),
      original = event(row.project_id, row.baseline_event_id),
      extract = extractExplicitPlanChange({
        text: e.content,
        role: e.role,
        operation: e.operation,
      })
    if (
      (!assessment && original.source_id !== e.source_id) ||
      baseline(row.project_id, row.task_id)?.id !== row.baseline_event_id ||
      !extract ||
      extract.quote !== row.quote ||
      extract.dueAt !== row.due_at ||
      (!assessment &&
        (linked(row.project_id, e).length !== 1 ||
          linked(row.project_id, e)[0]?.task_id !== row.task_id))
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
    if (
      [e, original, current].some(
        (value) =>
          getSourceStatus(db, row.project_id, value.source_id) !== 'active',
      )
    )
      guard = 'source_unavailable'
    else if (
      createRetractions(db).forEvent(row.project_id, e.id) ||
      createRetractions(db).forEvent(row.project_id, original.id) ||
      createRetractions(db).forEvent(row.project_id, current.id)
    )
      guard = 'retracted'
    else if (
      assessment &&
      assessment.proof.bindings.some(
        (f) =>
          !associations.bindingCurrent(
            row.project_id,
            row.task_id,
            f.id,
            f.version,
          ),
      )
    )
      guard = 'association_changed'
    else if (
      assessment &&
      assessment.proof.authorLinks.some(
        (f) =>
          f.mappingId !== null &&
          !associations.mappingCurrent(
            row.project_id,
            f.mappingId,
            f.mappingVersion!,
          ),
      )
    )
      guard = 'mapping_changed'
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
      assessment
        ? assessment.proof.authorLinks.some((f) => !f.matched)
        : original.source_id !== e.source_id ||
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
      !assessment &&
      db
        .prepare(
          "SELECT 1 FROM processing_evidence WHERE project_id=? AND task_id=? AND event_id=? AND reference_status='available'",
        )
        .get(row.project_id, row.task_id, row.baseline_event_id) === undefined
    )
      guard = 'reference_invalidated'
    else if (
      assessment &&
      assessment.proof.currentEventId !== current.id &&
      row.applied_at === null
    )
      guard = 'task_changed'
    else if (
      task.version !== row.task_version ||
      task.criteriaVersion !== row.criteria_version ||
      task.manualVersion !== row.manual_version
    )
      guard = 'task_changed'
    return {
      id: row.id,
      assessmentVersion: row.assessment_version,
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
    getAudit: readAudit,
    exportAssessmentsForTasks(projectId: string, taskIds: string[]) {
      id(projectId)
      if (!Array.isArray(taskIds) || taskIds.length > 1000) invalid()
      taskIds.forEach((t) => scope(projectId, t))
      if (!taskIds.length) return []
      const rows = db
        .prepare(
          `SELECT id,task_id FROM plan_change_assessments WHERE project_id=? AND task_id IN (${taskIds.map(() => '?').join(',')}) ORDER BY id LIMIT 50001`,
        )
        .all(projectId, ...taskIds) as { id: number; task_id: string }[]
      if (rows.length > 50000) throw Error('EXPORT_LIMIT_EXCEEDED')
      return rows.map((r) => readAudit(projectId, r.task_id, r.id))
    },
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
      const proof = makeProof(projectId, task.id, e, event(projectId, base.id))
      const inserted = db
        .prepare(
          'INSERT OR IGNORE INTO plan_change_proposals(project_id,task_id,event_id,baseline_event_id,due_at,quote,task_version,criteria_version,manual_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
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
      if (inserted.changes) {
        db.prepare(
          'UPDATE plan_change_proposals SET assessment_version=1 WHERE id=?',
        ).run(inserted.lastInsertRowid)
        const row = db
          .prepare('SELECT * FROM plan_change_proposals WHERE id=?')
          .get(inserted.lastInsertRowid) as Row
        appendAssessment(
          row,
          null,
          proof,
          'explicit-plan-change-v1',
          'explicit_plan_change',
          now,
          'rule',
        )
      }
    },
    reevaluate: db.transaction(
      (
        input: {
          projectId: string
          taskId: string
          eventId: number
          expectedVersion: number
          expectedCriteriaVersion: number
          expectedManualVersion: number
          reason: string
        },
        actorId: string,
      ) => {
        const task = scope(input.projectId, input.taskId)
        number(input.eventId, 1)
        id(actorId)
        if (
          actorId === 'explicit-plan-change-v1' ||
          typeof input.reason !== 'string' ||
          !input.reason.trim() ||
          input.reason.length > 512
        )
          invalid()
        if (
          task.version !== input.expectedVersion ||
          task.criteriaVersion !== input.expectedCriteriaVersion ||
          task.manualVersion !== input.expectedManualVersion
        )
          throw Error('VERSION_CONFLICT')
        const e = event(input.projectId, input.eventId),
          extract = extractExplicitPlanChange({
            text: e.content,
            role: e.role,
            operation: e.operation,
          }),
          base = baseline(input.projectId, input.taskId)
        if (!extract || !base || e.id === base.id)
          throw Error('PLAN_CHANGE_NOT_APPLICABLE')
        const proof = makeProof(
            input.projectId,
            input.taskId,
            e,
            event(input.projectId, base.id),
          ),
          now = new Date()
        let row = db
          .prepare(
            'SELECT * FROM plan_change_proposals WHERE project_id=? AND task_id=? AND event_id=?',
          )
          .get(input.projectId, input.taskId, input.eventId) as Row | undefined
        if (row) {
          validateRow(row)
          latestAudit(row)
          if (row.applied_at) throw Error('PLAN_CHANGE_NOT_APPLICABLE')
        }
        const before = row ? snapshot(row) : null
        if (!row) {
          const inserted = db
            .prepare(
              'INSERT INTO plan_change_proposals(project_id,task_id,event_id,baseline_event_id,due_at,quote,task_version,criteria_version,manual_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              input.projectId,
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
          row = db
            .prepare('SELECT * FROM plan_change_proposals WHERE id=?')
            .get(inserted.lastInsertRowid) as Row
        }
        db.prepare(
          'UPDATE plan_change_proposals SET baseline_event_id=?,task_version=?,criteria_version=?,manual_version=?,assessment_version=assessment_version+1 WHERE id=?',
        ).run(
          base.id,
          task.version,
          task.criteriaVersion,
          task.manualVersion,
          row.id,
        )
        row = db
          .prepare('SELECT * FROM plan_change_proposals WHERE id=?')
          .get(row.id) as Row
        appendAssessment(
          row,
          before,
          proof,
          actorId,
          input.reason,
          now,
          'manual',
        )
        return project(row)
      },
    ),
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
          expectedAssessmentVersion: number
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
        if (input.expectedAssessmentVersion !== row.assessment_version)
          throw Error('VERSION_CONFLICT')
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

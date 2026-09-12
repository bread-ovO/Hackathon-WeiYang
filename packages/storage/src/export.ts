import { createRetractions, type RetractionProof } from './retractions'
import type Database from 'better-sqlite3'
import type { StoredTask } from './task-model'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface ExportScope {
  projectId: string
  taskIds?: string[]
  includeSourceText: boolean
}
export interface ExportBundle {
  selection: { mode: 'project' } | { mode: 'tasks'; taskIds: string[] }
  schemaVersion: 3
  exportedAt: string
  project: { id: string; name: string }
  sourceBodiesIncluded: boolean
  tasks: StoredTask[]
  criteriaSets: {
    taskId: string
    version: number
    current: boolean
    items: { id: string; description: string; originEventId?: number }[]
  }[]
  evidence: {
    id: string
    taskId: string
    criterionVersion: number
    criterionId: string
    eventId: number
    relation: 'supports' | 'opposes' | 'related'
    validity: 'unknown' | 'valid' | 'invalid'
    reason: string
    currentCriterion: boolean
    referenceStatus: 'available' | 'invalidated'
    retraction: RetractionProof | null
  }[]
  decisions: {
    id: number
    taskId: string
    actor: 'manual'
    actorId: string
    scope: string
    reason: string
    createdAt: string
    taskVersion: number
    criteriaVersion: number
    manualVersion: number
    inputRefs: number[]
    payload: Json
    supersedes: number | null
  }[]
  /** Rule decisions are distinct from the manual audit trail. Added in schema v2. */
  ruleDecisions: {
    id: number
    taskId: string
    eventId: number
    actor: 'rule'
    outcome: 'created' | 'review_required'
    reason: string
    createdAt: string
    policyVersion: 'explicit-commitment-v1'
  }[]
  candidateEvidence: {
    id: number
    taskId: string
    eventId: number
    quoteStart: number
    quoteEnd: number
    quote?: string
    referenceStatus: 'available' | 'invalidated'
    retraction: RetractionProof | null
  }[]
  retractionImpacts: {
    eventId: number
    kind: 'processing' | 'manual'
    evidenceId: string
    priorValidity: string
  }[]
  revisions: {
    taskId: string
    version: number
    decisionId: number | null
    snapshot: Omit<StoredTask, 'dueAt'> & { dueAt?: string | null }
  }[]
  manualOverrides: { taskId: string; scope: string; decisionId: number }[]
  events: {
    id: number
    sourceInstanceId: string
    externalId: string
    revision: string
    occurredAt: string
    receivedAt: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    sourceStatus: 'active' | 'revoked' | 'unmanaged'
    operation: 'upsert' | 'retract'
    eventStatus: 'present' | 'retracted'
    retraction: RetractionProof | null
    text?: string
  }[]
}
export const EXPORT_MAX_BYTES = 16 * 1024 * 1024
const MAX_ROWS = 50000
function fail(): never {
  throw new Error('EXPORT_CORRUPT_DATA')
}
function object(
  value: unknown,
  allowed: string[],
  required = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(record, k))
  )
    fail()
  return record
}
function str(v: unknown, max = 65536): asserts v is string {
  if (typeof v !== 'string' || v.length > max) fail()
}
function num(v: unknown, min = 0): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) fail()
}
function one(v: unknown, values: readonly string[]) {
  if (typeof v !== 'string' || !values.includes(v)) fail()
}
function parse(raw: unknown): unknown {
  str(raw)
  try {
    return JSON.parse(raw)
  } catch {
    fail()
  }
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
function taskSnapshot(
  value: unknown,
  legacy = false,
): ExportBundle['revisions'][number]['snapshot'] {
  const r = object(
    value,
    taskKeys,
    legacy ? taskKeys.filter((k) => k !== 'dueAt') : taskKeys,
  )
  for (const k of ['id', 'title']) str(r[k])
  for (const k of ['projectId', 'owner', 'archivedAt', 'dueAt'])
    if (r[k] !== null && r[k] !== undefined) str(r[k])
  one(r.status, ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'])
  one(r.evidenceStatus, ['unknown', 'partial', 'sufficient', 'conflict'])
  one(r.admission, ['candidate', 'accepted', 'ignored'])
  num(r.version, 1)
  num(r.criteriaVersion)
  num(r.manualVersion)
  return r as unknown as ExportBundle['revisions'][number]['snapshot']
}
function criterion(value: unknown) {
  const r = object(
    value,
    ['id', 'description', 'originEventId'],
    ['id', 'description'],
  )
  str(r.id, 256)
  str(r.description, 512)
  if (r.originEventId !== undefined) num(r.originEventId, 1)
  return r
}
function decisionPayload(scope: string, value: unknown): Json {
  if (scope === 'criteria') {
    if (!Array.isArray(value) || value.length > 32) fail()
    value.forEach(criterion)
    return value as Json
  }
  if (scope.startsWith('evidence:')) {
    const r = object(value, [
      'id',
      'criterionId',
      'criteriaVersion',
      'eventId',
      'relation',
      'validity',
      'reason',
    ])
    str(r.id)
    str(r.criterionId)
    num(r.criteriaVersion, 1)
    num(r.eventId, 1)
    one(r.relation, ['supports', 'opposes', 'related'])
    one(r.validity, ['unknown', 'valid', 'invalid'])
    str(r.reason)
    return r as Json
  }
  if (scope === 'create') {
    const r = object(value, ['title'])
    str(r.title, 512)
    return r as Json
  }
  if (scope === 'project') {
    const r = object(value, ['projectId'])
    str(r.projectId, 256)
    return r as Json
  }
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
  const r = object(value, keys)
  for (const k of ['title', 'owner', 'dueAt'])
    if (r[k] !== undefined && r[k] !== null) str(r[k])
  if (r.status !== undefined)
    one(r.status, ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'])
  if (r.admission !== undefined)
    one(r.admission, ['candidate', 'accepted', 'ignored'])
  if (r.archived !== undefined && typeof r.archived !== 'boolean') fail()
  return r as Json
}
export function createExports(db: Database.Database) {
  return {
    build: db.transaction((scope: ExportScope): ExportBundle => {
      const validId = (v: unknown) =>
        typeof v === 'string' &&
        v.length > 0 &&
        v.length <= 256 &&
        v.trim().length > 0 &&
        !/[\u0000-\u001f\u007f]/.test(v)
      if (
        !scope ||
        !validId(scope.projectId) ||
        typeof scope.includeSourceText !== 'boolean' ||
        (scope.taskIds !== undefined &&
          (!Array.isArray(scope.taskIds) ||
            !scope.taskIds.length ||
            scope.taskIds.length > 1000 ||
            scope.taskIds.some((id) => !validId(id)) ||
            new Set(scope.taskIds).size !== scope.taskIds.length))
      )
        throw new Error('EXPORT_INVALID_INPUT')
      const project = db
        .prepare('SELECT id,name FROM projects WHERE id=?')
        .get(scope.projectId) as { id: string; name: string } | undefined
      if (!project) throw new Error('EXPORT_UNKNOWN_PROJECT')
      let count = 0
      let bytes = 0
      const account = (value: unknown) => {
        bytes += Buffer.byteLength(JSON.stringify(value), 'utf8')
        if (bytes > EXPORT_MAX_BYTES || ++count > MAX_ROWS)
          throw new Error('EXPORT_LIMIT_EXCEEDED')
      }
      function rows<T>(
        sql: string,
        params: (string | number)[],
        map: (row: Record<string, unknown>) => T,
      ): T[] {
        const result: T[] = []
        for (const raw of db
          .prepare(sql + ` LIMIT ${MAX_ROWS + 1}`)
          .iterate(...params)) {
          const row = map(raw as Record<string, unknown>)
          account(row)
          result.push(row)
        }
        return result
      }
      const taskFilter = scope.taskIds
        ? ` AND id IN (${scope.taskIds.map(() => '?').join(',')})`
        : ''
      const tasks = rows(
        `SELECT id,project_id AS projectId,title,owner,status,evidence_status AS evidenceStatus,admission,version,criteria_version AS criteriaVersion,manual_version AS manualVersion,archived_at AS archivedAt,due_at AS dueAt FROM tasks WHERE project_id=?${taskFilter} ORDER BY id`,
        [scope.projectId, ...(scope.taskIds ?? [])],
        (row) => taskSnapshot(row) as StoredTask,
      )
      if (tasks.length > 1000) throw new Error('EXPORT_LIMIT_EXCEEDED')
      if (scope.taskIds && tasks.length !== scope.taskIds.length)
        throw new Error('EXPORT_TASK_NOT_IN_PROJECT')
      const bundle: ExportBundle = {
        schemaVersion: 3,
        selection: scope.taskIds
          ? { mode: 'tasks', taskIds: [...scope.taskIds].sort() }
          : { mode: 'project' },
        exportedAt: new Date().toISOString(),
        project,
        sourceBodiesIncluded: scope.includeSourceText,
        tasks,
        criteriaSets: [],
        evidence: [],
        decisions: [],
        ruleDecisions: [],
        candidateEvidence: [],
        retractionImpacts: [],
        revisions: [],
        manualOverrides: [],
        events: [],
      }
      if (!tasks.length) return bundle
      const taskMap = new Map(tasks.map((t) => [t.id, t]))
      const ids = tasks.map((t) => t.id)
      const selected = ids.map(() => '?').join(',')
      const refs = new Set<number>()
      const addRef = (v: unknown) => {
        num(v, 1)
        refs.add(v)
        return v
      }
      const retractions = createRetractions(db)
      const retractionFor = (eventId: number): RetractionProof | null => {
        try {
          const proof = retractions.forEvent(scope.projectId, eventId)
          if (proof) addRef(proof.eventId)
          return proof
        } catch {
          return fail()
        }
      }
      bundle.criteriaSets = rows(
        `SELECT task_id AS taskId,version FROM criterion_sets WHERE task_id IN (${selected}) ORDER BY task_id,version`,
        ids,
        (r) => {
          str(r.taskId)
          num(r.version, 1)
          return {
            taskId: r.taskId,
            version: r.version,
            current: taskMap.get(r.taskId)!.criteriaVersion === r.version,
            items: [],
          }
        },
      )
      const sets = new Map(
        bundle.criteriaSets.map((s) => [
          JSON.stringify([s.taskId, s.version]),
          s,
        ]),
      )
      const criteria = rows(
        `SELECT task_id AS taskId,version,criterion_id AS id,description,origin_event_id AS originEventId FROM criteria WHERE task_id IN (${selected}) ORDER BY task_id,version,criterion_id`,
        ids,
        (r) => r,
      )
      const criterionKeys = new Set<string>()
      for (const r of criteria) {
        str(r.taskId)
        num(r.version, 1)
        str(r.id, 256)
        str(r.description, 512)
        const set = sets.get(JSON.stringify([r.taskId, r.version]))
        if (!set) fail()
        set.items.push({
          id: r.id,
          description: r.description,
          ...(r.originEventId === null
            ? {}
            : { originEventId: addRef(r.originEventId) }),
        })
        criterionKeys.add(JSON.stringify([r.taskId, r.version, r.id]))
      }
      for (const task of tasks)
        if (
          task.criteriaVersion > 0 &&
          !sets.has(JSON.stringify([task.id, task.criteriaVersion]))
        )
          fail()
      bundle.evidence = rows(
        `SELECT id,task_id AS taskId,criterion_version AS criterionVersion,criterion_id AS criterionId,event_id AS eventId,relation,validity,reason FROM evidence_links WHERE task_id IN (${selected}) ORDER BY id`,
        ids,
        (r) => {
          str(r.id)
          str(r.taskId)
          num(r.criterionVersion, 1)
          str(r.criterionId)
          str(r.reason)
          one(r.relation, ['supports', 'opposes', 'related'])
          one(r.validity, ['unknown', 'valid', 'invalid'])
          addRef(r.eventId)
          if (
            !criterionKeys.has(
              JSON.stringify([r.taskId, r.criterionVersion, r.criterionId]),
            )
          )
            fail()
          const retraction = retractionFor(r.eventId as number)
          if (retraction && r.validity !== 'invalid') fail()
          return {
            ...r,
            referenceStatus: retraction ? 'invalidated' : 'available',
            retraction,
            currentCriterion:
              taskMap.get(r.taskId)!.criteriaVersion === r.criterionVersion,
          } as ExportBundle['evidence'][number]
        },
      )
      bundle.decisions = rows(
        `SELECT id,task_id AS taskId,actor,actor_id AS actorId,scope,reason,created_at AS createdAt,task_version AS taskVersion,criteria_version AS criteriaVersion,manual_version AS manualVersion,input_refs AS inputRefs,payload,supersedes FROM decisions WHERE task_id IN (${selected}) ORDER BY id`,
        ids,
        (r) => {
          num(r.id, 1)
          str(r.taskId)
          one(r.actor, ['manual'])
          str(r.actorId)
          str(r.scope)
          str(r.reason)
          str(r.createdAt)
          num(r.taskVersion, 1)
          num(r.criteriaVersion)
          num(r.manualVersion)
          if (r.supersedes !== null) num(r.supersedes, 1)
          const inputRefs = parse(r.inputRefs)
          if (!Array.isArray(inputRefs)) fail()
          inputRefs.forEach(addRef)
          const payload = decisionPayload(r.scope, parse(r.payload))
          if (r.scope === 'criteria')
            for (const item of payload as Record<string, Json>[])
              if (item.originEventId !== undefined) addRef(item.originEventId)
          if (r.scope.startsWith('evidence:'))
            addRef((payload as Record<string, Json>).eventId)
          return {
            ...r,
            inputRefs,
            payload,
          } as ExportBundle['decisions'][number]
        },
      )
      bundle.ruleDecisions = rows(
        `SELECT d.id,d.project_id AS projectId,d.task_id AS taskId,d.event_id AS eventId,d.actor,d.outcome,d.reason,d.created_at AS createdAt,r.rule_version AS policyVersion,r.project_id AS resultProject,r.outcome AS resultOutcome,r.reason AS resultReason
          FROM processing_decisions d LEFT JOIN processing_results r ON r.event_id=d.event_id
          WHERE d.task_id IN (${selected}) ORDER BY d.id`,
        ids,
        (r) => {
          num(r.id, 1)
          str(r.taskId, 256)
          addRef(r.eventId)
          if (
            r.projectId !== scope.projectId ||
            r.resultProject !== scope.projectId ||
            r.outcome !== r.resultOutcome ||
            r.reason !== r.resultReason
          )
            fail()
          one(r.actor, ['rule'])
          one(r.outcome, ['created', 'review_required'])
          one(r.reason, [
            'explicit_commitment',
            'plan_change',
            'candidate_limit',
            'source_revision_requires_review',
            'source_retracted',
            'source_object_retracted',
          ])
          one(r.policyVersion, ['explicit-commitment-v1'])
          str(r.createdAt, 32)
          if (
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
              r.createdAt,
            ) ||
            !Number.isFinite(Date.parse(r.createdAt))
          )
            fail()
          return {
            id: r.id,
            taskId: r.taskId,
            eventId: r.eventId,
            actor: 'rule',
            outcome: r.outcome,
            reason: r.reason,
            createdAt: r.createdAt,
            policyVersion: r.policyVersion,
          } as ExportBundle['ruleDecisions'][number]
        },
      )
      const ruleLinks = new Set(
        bundle.ruleDecisions
          .filter((d) => d.outcome === 'created')
          .map((d) => JSON.stringify([d.taskId, d.eventId])),
      )
      bundle.candidateEvidence = rows(
        `SELECT p.id,p.project_id AS projectId,p.task_id AS taskId,p.event_id AS eventId,p.quote_start AS quoteStart,p.quote_end AS quoteEnd,p.quote,p.reference_status AS referenceStatus,p.invalidated_by_event_id AS invalidatedBy,e.content
         FROM processing_evidence p LEFT JOIN source_events e ON e.id=p.event_id WHERE p.task_id IN (${selected}) ORDER BY p.id`,
        ids,
        (r) => {
          num(r.id, 1)
          str(r.taskId, 256)
          addRef(r.eventId)
          num(r.quoteStart)
          num(r.quoteEnd, 1)
          str(r.quote, 65536)
          str(r.content, 65536)
          if (
            r.projectId !== scope.projectId ||
            !ruleLinks.has(JSON.stringify([r.taskId, r.eventId])) ||
            r.quoteStart >= r.quoteEnd ||
            r.quoteEnd > r.content.length ||
            r.content.slice(r.quoteStart, r.quoteEnd) !== r.quote
          )
            fail()
          const retraction = retractionFor(r.eventId as number)
          if (
            r.referenceStatus !== (retraction ? 'invalidated' : 'available') ||
            r.invalidatedBy !== (retraction?.eventId ?? null)
          )
            fail()
          return {
            id: r.id,
            taskId: r.taskId,
            eventId: r.eventId,
            referenceStatus: r.referenceStatus,
            retraction,
            quoteStart: r.quoteStart,
            quoteEnd: r.quoteEnd,
            ...(scope.includeSourceText ? { quote: r.quote } : {}),
          } as ExportBundle['candidateEvidence'][number]
        },
      )
      const citedRuleLinks = new Set(
        bundle.candidateEvidence.map((e) =>
          JSON.stringify([e.taskId, e.eventId]),
        ),
      )
      for (const link of ruleLinks) if (!citedRuleLinks.has(link)) fail()
      const decisions = new Map(bundle.decisions.map((d) => [d.id, d]))
      for (const d of bundle.decisions) {
        if (
          d.supersedes !== null &&
          (decisions.get(d.supersedes)?.taskId !== d.taskId ||
            d.supersedes >= d.id)
        )
          fail()
        if (
          d.criteriaVersion > 0 &&
          !sets.has(JSON.stringify([d.taskId, d.criteriaVersion]))
        )
          fail()
      }
      bundle.revisions = rows(
        `SELECT task_id AS taskId,version,decision_id AS decisionId,snapshot FROM task_revisions WHERE task_id IN (${selected}) ORDER BY task_id,version`,
        ids,
        (r) => {
          str(r.taskId)
          num(r.version, 1)
          const snapshot = taskSnapshot(parse(r.snapshot), true)
          if (
            snapshot.criteriaVersion > 0 &&
            !sets.has(JSON.stringify([r.taskId, snapshot.criteriaVersion]))
          )
            fail()
          if (
            snapshot.id !== r.taskId ||
            snapshot.version !== r.version ||
            (snapshot.projectId !== null &&
              snapshot.projectId !== scope.projectId)
          )
            fail()
          if (r.decisionId !== null) {
            num(r.decisionId, 1)
            const d = decisions.get(r.decisionId)
            if (d?.taskId !== r.taskId || d.taskVersion !== r.version) fail()
          }
          return {
            taskId: r.taskId,
            version: r.version,
            decisionId: r.decisionId,
            snapshot,
          } as ExportBundle['revisions'][number]
        },
      )
      // History is complete only when every version after its legitimate baseline exists.
      // Legacy assignments preserve one unassigned snapshot at the old database version;
      // ordinary tasks must begin at version 1. Never synthesize missing snapshots.
      for (const task of tasks) {
        const history = bundle.revisions.filter(
          (revision) => revision.taskId === task.id,
        )
        const first = history[0]
        if (!first) fail()
        const legacyBaseline =
          first.snapshot.projectId === null && first.decisionId === null
        if (!legacyBaseline && first.version !== 1) fail()
        if (
          !legacyBaseline &&
          first.snapshot.manualVersion === 0 &&
          !bundle.ruleDecisions.some(
            (d) => d.taskId === task.id && d.outcome === 'created',
          )
        )
          fail()
        if (
          first.version > task.version ||
          history.length !== task.version - first.version + 1
        )
          fail()
        for (let index = 0; index < history.length; index++) {
          if (history[index]!.version !== first.version + index) fail()
        }
        const latest = history.at(-1)!
        if (latest.version !== task.version) fail()
        for (const key of taskKeys as (keyof StoredTask)[]) {
          const historical = latest.snapshot[key]
          // Pre-v4 history did not contain dueAt; a null current date is equivalent
          // for comparison only. The exported historical object stays untouched.
          if (
            key === 'dueAt' &&
            historical === undefined &&
            task.dueAt === null
          )
            continue
          if (historical !== task[key]) fail()
        }
      }
      bundle.manualOverrides = rows(
        `SELECT task_id AS taskId,scope,decision_id AS decisionId FROM manual_overrides WHERE task_id IN (${selected}) ORDER BY task_id,scope`,
        ids,
        (r) => {
          str(r.taskId)
          str(r.scope)
          num(r.decisionId, 1)
          if (decisions.get(r.decisionId)?.taskId !== r.taskId) fail()
          return r as ExportBundle['manualOverrides'][number]
        },
      )
      // Include the structural retraction fact even while background processing is paused.
      for (const eventId of refs) retractionFor(eventId)
      bundle.retractionImpacts = rows(
        `SELECT i.retraction_event_id AS eventId,i.kind,i.evidence_id AS evidenceId,i.prior_validity AS priorValidity
         FROM retraction_impacts i WHERE i.project_id=? AND (
           (i.kind='processing' AND EXISTS(SELECT 1 FROM processing_evidence p WHERE CAST(p.id AS TEXT)=i.evidence_id AND p.task_id IN (${selected}))) OR
           (i.kind='manual' AND EXISTS(SELECT 1 FROM evidence_links e WHERE e.id=i.evidence_id AND e.task_id IN (${selected}))))
         ORDER BY i.retraction_event_id,i.kind,i.evidence_id`,
        [scope.projectId, ...ids, ...ids],
        (r) => {
          addRef(r.eventId)
          one(r.kind, ['processing', 'manual'])
          str(r.evidenceId)
          one(
            r.priorValidity,
            r.kind === 'processing'
              ? ['available', 'invalidated']
              : ['unknown', 'valid', 'invalid'],
          )
          const linked =
            r.kind === 'processing'
              ? bundle.candidateEvidence.find(
                  (e) => String(e.id) === r.evidenceId,
                )
              : bundle.evidence.find((e) => e.id === r.evidenceId)
          if (!linked || linked.retraction?.eventId !== r.eventId) fail()
          return r as ExportBundle['retractionImpacts'][number]
        },
      )
      for (const [kind, links] of [
        ['processing', bundle.candidateEvidence],
        ['manual', bundle.evidence],
      ] as const) {
        for (const link of links) {
          if (
            link.retraction &&
            !bundle.retractionImpacts.some(
              (impact) =>
                impact.kind === kind &&
                impact.evidenceId === String(link.id) &&
                impact.eventId === link.retraction!.eventId,
            )
          )
            fail()
        }
      }
      // Query only linked events; inspect each row incrementally before allocating the full bundle.
      for (const eventId of [...refs].sort((a, b) => a - b)) {
        const r = db
          .prepare(
            `SELECT e.id,e.source_id AS sourceInstanceId,e.external_id AS externalId,e.revision,e.occurred_at AS occurredAt,e.received_at AS receivedAt,e.role,e.operation,
        CASE WHEN g.source_id IS NOT NULL THEN CASE WHEN g.revoked=1 THEN 'revoked' ELSE 'active' END WHEN h.source_instance_id IS NOT NULL THEN CASE WHEN b.source_instance_id=e.source_id AND b.enabled=1 AND b.uninstalled=0 THEN 'active' ELSE 'revoked' END ELSE 'unmanaged' END AS sourceStatus${scope.includeSourceText ? ',e.content AS text' : ''}
        FROM source_events e LEFT JOIN source_grants g ON g.source_id=e.source_id LEFT JOIN plugin_source_history h ON h.source_instance_id=e.source_id LEFT JOIN plugin_bindings b ON b.id=h.plugin_id JOIN event_projects p ON p.event_id=e.id AND p.project_id=? WHERE e.id=?`,
          )
          .get(scope.projectId, eventId) as Record<string, unknown> | undefined
        if (!r) fail()
        num(r.id, 1)
        for (const key of [
          'sourceInstanceId',
          'externalId',
          'revision',
          'occurredAt',
          'receivedAt',
        ])
          str(r[key])
        one(r.role, ['user', 'assistant', 'tool', 'system'])
        one(r.operation, ['upsert', 'retract'])
        const retraction = retractionFor(eventId)
        r.eventStatus = retraction ? 'retracted' : 'present'
        r.retraction = retraction
        if (scope.includeSourceText) str(r.text)
        account(r)
        bundle.events.push(r as ExportBundle['events'][number])
      }
      if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > EXPORT_MAX_BYTES)
        throw new Error('EXPORT_LIMIT_EXCEEDED')
      return bundle
    }),
  }
}

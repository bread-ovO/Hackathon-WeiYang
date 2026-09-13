import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  parseCoreRequest,
  parseSourceEvent,
  type PetContextFact,
  type PetContextFacts,
} from '@memo/contracts'
import { parseContextTimestamp } from '@memo/domain'
import { createTaskModel } from './task-model'
import { createRevisionReview, type ReferenceKind } from './revision-review'
import { createRetractions } from './retractions'
import { eventMetadataFields } from './event-metadata'

type Ref = { kind: ReferenceKind; id: string }
/** Read-only local facts. Digests establish snapshot equality, not renderer authorization. */
export function createPetContext(db: Database.Database) {
  const tasks = createTaskModel(db),
    reviews = createRevisionReview(db)
  const unavailable = (): never => {
    throw Error('PET_CONTEXT_UNAVAILABLE')
  }
  function authorization(projectId: string, sourceId: string) {
    const rows = db
      .prepare(
        `SELECT 'source' kind,source_id id,grant_version version,revoked FROM source_grants WHERE project_id=? AND source_id=?
   UNION ALL SELECT 'plugin',id,grant_version,CASE WHEN uninstalled=0 AND enabled=1 THEN 0 ELSE 1 END FROM plugin_bindings WHERE project_id=? AND source_instance_id=?
   UNION ALL SELECT 'github',source_id,grant_version,CASE WHEN revoked=0 AND enabled=1 THEN 0 ELSE 1 END FROM github_connections WHERE project_id=? AND source_id=?
   UNION ALL SELECT 'feishu',source_id,grant_version,CASE WHEN revoked=0 AND enabled=1 THEN 0 ELSE 1 END FROM feishu_connections WHERE project_id=? AND source_id=?`,
      )
      .all(
        projectId,
        sourceId,
        projectId,
        sourceId,
        projectId,
        sourceId,
        projectId,
        sourceId,
      ) as { kind: string; id: string; version: number; revoked: number }[]
    if (!rows.length) return null
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(rows[0]!.version) ||
      rows[0]!.version < 1 ||
      ![0, 1].includes(rows[0]!.revoked)
    )
      unavailable()
    return rows[0]!.revoked === 0 ? rows[0]! : null
  }
  function build(
    projectId: string,
    taskId: string,
    ref: Ref,
  ): PetContextFact | null {
    const task = tasks.get(projectId, taskId)
    if (!task || task.admission !== 'accepted' || task.archivedAt !== null)
      return null
    if (
      !task.title ||
      [...task.title].length > 120 ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(task.title)
    )
      return null
    let refData: unknown
    if (ref.kind === 'manual') {
      const row = db
        .prepare(
          'SELECT l.* FROM evidence_links l JOIN criteria c ON c.task_id=l.task_id AND c.project_id=l.project_id AND c.version=l.criterion_version AND c.criterion_id=l.criterion_id WHERE l.project_id=? AND l.task_id=? AND l.id=? AND l.criterion_version=?',
        )
        .get(projectId, taskId, ref.id, task.criteriaVersion) as
        | { validity: string; relation: string }
        | undefined
      if (!row) return null
      if (
        !['valid', 'unknown', 'invalid'].includes(row.validity) ||
        !['supports', 'opposes', 'related'].includes(row.relation)
      )
        unavailable()
      refData = row
    } else {
      const row = db
        .prepare(
          'SELECT * FROM processing_evidence WHERE project_id=? AND task_id=? AND CAST(id AS TEXT)=?',
        )
        .get(projectId, taskId, ref.id) as
        | {
            reference_status: string
            event_id: number
            quote: string
            quote_start: number
            quote_end: number
          }
        | undefined
      if (!row) return null
      if (!['available', 'invalidated'].includes(row.reference_status))
        unavailable()
      const original = db
        .prepare(
          'SELECT e.content FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id=?',
        )
        .get(projectId, row.event_id) as { content: string } | undefined
      if (
        !original ||
        !Number.isSafeInteger(row.quote_start) ||
        !Number.isSafeInteger(row.quote_end) ||
        row.quote_start < 0 ||
        row.quote_end <= row.quote_start ||
        row.quote_end > original.content.length ||
        original.content.slice(row.quote_start, row.quote_end) !== row.quote
      )
        return unavailable()
      // An explicitly confirmed variant can replace the effective reference, while the original quote stays invalid.
      refData = row
    }
    const review = reviews.reviewReference({
      projectId,
      taskId,
      referenceKind: ref.kind,
      referenceId: ref.id,
      limit: 1,
    })
    if (
      !['available', 'confirmed'].includes(review.reference.status) ||
      review.reference.sourceStatus !== 'active'
    )
      return null
    if (
      ref.kind === 'manual' &&
      review.reference.status === 'available' &&
      (refData as { validity: string }).validity !== 'valid'
    )
      return null
    if (
      review.reference.status === 'confirmed' &&
      (!review.confirmation ||
        !['valid', 'available'].includes(review.confirmation.validity))
    )
      return null
    const eventId =
      review.reference.status === 'confirmed'
        ? review.confirmation!.eventId
        : review.reference.eventId
    const event = db
      .prepare(
        'SELECT e.* FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id=?',
      )
      .get(projectId, eventId) as
      | {
          source_id: string
          external_id: string
          revision: string
          role: string
          content: string
          operation: string
          occurred_at: string
          received_at: string
          metadata_json: string | null
        }
      | undefined
    if (
      !event ||
      event.source_id !== review.reference.sourceInstanceId ||
      event.external_id !== review.reference.externalId
    )
      return unavailable()
    const parsed = parseSourceEvent({
      schemaVersion: 1,
      sourceInstanceId: event.source_id,
      externalId: event.external_id,
      revision: event.revision,
      role: event.role,
      text: event.content,
      operation: event.operation,
      occurredAt: event.occurred_at,
      ...eventMetadataFields(event.metadata_json),
    })
    parseContextTimestamp(parsed.occurredAt)
    parseContextTimestamp(event.received_at)
    if (
      parsed.operation === 'retract' ||
      createRetractions(db).forEvent(projectId, eventId)
    )
      return null
    const grant = authorization(projectId, event.source_id)
    if (!grant) return null
    const snapshot = {
      projectId,
      taskId,
      taskVersion: task.version,
      criteriaVersion: task.criteriaVersion,
      manualVersion: task.manualVersion,
      title: task.title,
      status: task.status,
      referenceId: `${ref.kind}:${ref.id}`,
      eventId,
    }
    const proof = createHash('sha256')
      .update(
        JSON.stringify({
          snapshot,
          grant,
          reference: review.reference,
          contentDigest: review.knownContentSetDigest,
          confirmation: review.confirmation,
          refData,
          event: parsed,
        }),
      )
      .digest('hex')
    const fact = { ...snapshot, proof }
    const validated = parseCoreRequest({
      method: 'workspace.validatePetContextFact',
      fact,
    })
    if (validated.method !== 'workspace.validatePetContextFact')
      return unavailable()
    return validated.fact
  }
  return {
    facts: db.transaction((projectIds: string[]): PetContextFacts => {
      try {
        const input = parseCoreRequest({
          method: 'workspace.petContextFacts',
          projectIds,
        })
        if (input.method !== 'workspace.petContextFacts')
          throw Error('PET_CONTEXT_INVALID_INPUT')
        for (const p of projectIds)
          if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(p))
            throw Error('PET_CONTEXT_INVALID_INPUT')
        if (!projectIds.length) return { facts: [] }
        const candidates = db
          .prepare(
            `SELECT id,project_id FROM tasks WHERE admission='accepted' AND archived_at IS NULL AND project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY project_id,id LIMIT 100`,
          )
          .all(...[...projectIds].sort()) as {
          id: string
          project_id: string
        }[]
        const facts: PetContextFact[] = []
        for (const task of candidates) {
          const refs = db
            .prepare(
              `SELECT 'manual' kind,id FROM evidence_links WHERE project_id=? AND task_id=? UNION ALL SELECT 'processing',CAST(id AS TEXT) FROM processing_evidence WHERE project_id=? AND task_id=? ORDER BY kind,id LIMIT 64`,
            )
            .all(task.project_id, task.id, task.project_id, task.id) as Ref[]
          for (const ref of refs) {
            const fact = build(task.project_id, task.id, ref)
            if (fact) {
              facts.push(fact)
              break
            }
          }
          if (facts.length === 3) break
        }
        return { facts }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'PET_CONTEXT_INVALID_INPUT'
        )
          throw error
        return unavailable()
      }
    }),
    validate: db.transaction((fact: PetContextFact): boolean => {
      try {
        const parsed = parseCoreRequest({
          method: 'workspace.validatePetContextFact',
          fact,
        })
        if (parsed.method !== 'workspace.validatePetContextFact') return false
        const colon = fact.referenceId.indexOf(':'),
          kind = fact.referenceId.slice(0, colon) as ReferenceKind,
          id = fact.referenceId.slice(colon + 1)
        const current = build(fact.projectId, fact.taskId, { kind, id })
        return (
          !!current &&
          Object.keys(current).every(
            (key) =>
              current[key as keyof PetContextFact] ===
              fact[key as keyof PetContextFact],
          )
        )
      } catch {
        return false
      }
    }),
  }
}

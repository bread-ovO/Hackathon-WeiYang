import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createRetractions } from './retractions'

export type ReferenceKind = 'processing' | 'manual'
export interface ReferenceInput {
  projectId: string
  taskId: string
  referenceKind: ReferenceKind
  referenceId: string
}
export interface RevisionReview {
  reference: {
    kind: ReferenceKind
    id: string
    version: number
    eventId: number
    sourceInstanceId: string
    externalId: string
    originalReferenceStatus: 'available' | 'invalidated'
    status: 'available' | 'review_required' | 'confirmed' | 'invalidated'
  }
  knownContentSetDigest: string
  events: {
    id: number
    revision: string
    occurredAt: string
    receivedAt: string
    text: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    operation: 'upsert'
  }[]
  nextCursor: string | null
  confirmedEventId: number | null
  confirmation: null | {
    eventId: number
    revision: string
    text: string
    role: 'user' | 'assistant' | 'tool' | 'system'
    reason: string
    createdAt: string
    actorId: string
    validity: 'available' | 'valid' | 'unknown' | 'invalid'
  }
}
export function migrateRevisionReview(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE reference_revision_reviews(project_id TEXT NOT NULL,task_id TEXT NOT NULL,reference_kind TEXT NOT NULL CHECK(reference_kind IN ('processing','manual')),reference_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),content_digest TEXT NOT NULL,selected_event_id INTEGER REFERENCES source_events(id),prior_validity TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('available','review_required','confirmed')),PRIMARY KEY(project_id,reference_kind,reference_id),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
 CREATE TABLE reference_revision_decisions(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,reference_kind TEXT NOT NULL,reference_id TEXT NOT NULL,reference_version INTEGER NOT NULL,chosen_event_id INTEGER NOT NULL REFERENCES source_events(id),content_digest TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
 PRAGMA user_version=11;`)
    // Existing references are conservatively reconciled from the full known set.
    const api = createRevisionReview(db)
    for (let offset = 0; ; offset += 500) {
      const rows = db
        .prepare(
          `SELECT v.project_id AS projectId,min(v.event_id) AS eventId FROM (SELECT project_id,event_id FROM processing_evidence UNION ALL SELECT project_id,event_id FROM evidence_links) v JOIN source_events e ON e.id=v.event_id GROUP BY v.project_id,e.source_id,e.external_id ORDER BY v.project_id,e.source_id,e.external_id LIMIT 500 OFFSET ?`,
        )
        .all(offset) as { projectId: string; eventId: number }[]
      for (const row of rows) api.observe(row.projectId, row.eventId)
      if (rows.length < 500) break
    }
  })()
}
export function createRevisionReview(db: Database.Database) {
  function validate(i: ReferenceInput) {
    if (
      !i ||
      !['processing', 'manual'].includes(i.referenceKind) ||
      [i.projectId, i.taskId, i.referenceId].some(
        (v) => typeof v !== 'string' || !v.length || v.length > 256,
      )
    )
      throw Error('INVALID_REFERENCE_REVIEW')
  }
  function reference(i: ReferenceInput) {
    validate(i)
    const table =
      i.referenceKind === 'processing'
        ? 'processing_evidence'
        : 'evidence_links'
    const row = db
      .prepare(
        `SELECT v.event_id AS eventId,e.source_id AS sourceId,e.external_id AS externalId,${i.referenceKind === 'manual' ? 'v.validity' : "'available'"} AS validity,${i.referenceKind === 'processing' ? 'v.reference_status' : 'NULL'} AS storedStatus,${i.referenceKind === 'processing' ? 'v.invalidated_by_event_id' : 'NULL'} AS storedInvalidatedBy FROM ${table} v JOIN source_events e ON e.id=v.event_id JOIN event_projects ep ON ep.event_id=e.id AND ep.project_id=v.project_id WHERE v.project_id=? AND v.task_id=? AND CAST(v.id AS TEXT)=?`,
      )
      .get(i.projectId, i.taskId, i.referenceId) as
      | {
          eventId: number
          sourceId: string
          externalId: string
          validity: string
          storedStatus: string | null
          storedInvalidatedBy: number | null
        }
      | undefined
    if (!row) throw Error('INVALID_REFERENCE_REVIEW')
    if (i.referenceKind === 'processing') {
      const proof = createRetractions(db).forEvent(i.projectId, row.eventId)
      if (
        row.storedStatus !== (proof ? 'invalidated' : 'available') ||
        row.storedInvalidatedBy !== (proof?.eventId ?? null)
      )
        throw Error('INVALID_RETRACTION_DATA')
    }
    return row
  }
  function contents(projectId: string, sourceId: string, externalId: string) {
    const hash = createHash('sha256')
    let count = 0
    // SQLite owns distinct sorting (and can spill to its temporary store). Keep
    // only one bounded event body in JS, with an unambiguous JSON-line encoding.
    for (const e of db
      .prepare(
        `SELECT DISTINCT e.role,e.content AS text FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.source_id=? AND e.external_id=? AND e.operation='upsert' ORDER BY e.role COLLATE BINARY,e.content COLLATE BINARY`,
      )
      .iterate(projectId, sourceId, externalId) as Iterable<{
      role: string
      text: string
    }>) {
      hash.update(JSON.stringify([e.role, e.text])).update('\n')
      count++
    }
    const eventCount = (
      db
        .prepare(
          `SELECT count(*) AS n FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.source_id=? AND e.external_id=? AND e.operation='upsert'`,
        )
        .get(projectId, sourceId, externalId) as { n: number }
    ).n
    return { eventCount, digest: hash.digest('hex'), count }
  }
  function stored(i: ReferenceInput) {
    const row = db
      .prepare(
        'SELECT * FROM reference_revision_reviews WHERE project_id=? AND reference_kind=? AND reference_id=?',
      )
      .get(i.projectId, i.referenceKind, i.referenceId) as
      | {
          task_id: string
          version: number
          content_digest: string
          selected_event_id: number | null
          prior_validity: string
          status: 'available' | 'review_required' | 'confirmed'
        }
      | undefined
    if (
      row &&
      (row.task_id !== i.taskId ||
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        !/^[0-9a-f]{64}$/.test(row.content_digest) ||
        !['available', 'review_required', 'confirmed'].includes(row.status) ||
        (row.status === 'confirmed') !== (row.selected_event_id !== null) ||
        !(
          i.referenceKind === 'manual'
            ? ['valid', 'unknown', 'invalid']
            : ['available']
        ).includes(row.prior_validity))
    )
      throw Error('INVALID_REFERENCE_REVIEW')
    return row
  }
  function reconcile(i: ReferenceInput) {
    const ref = reference(i),
      set = contents(i.projectId, ref.sourceId, ref.externalId),
      old = stored(i)
    if (old?.content_digest === set.digest) return
    const status = set.count > 1 ? 'review_required' : 'available'
    db.prepare(
      `INSERT INTO reference_revision_reviews VALUES(?,?,?,?,?,?,NULL,?,?) ON CONFLICT(project_id,reference_kind,reference_id) DO UPDATE SET version=version+1,content_digest=excluded.content_digest,selected_event_id=NULL,status=excluded.status`,
    ).run(
      i.projectId,
      i.taskId,
      i.referenceKind,
      i.referenceId,
      1,
      set.digest,
      ref.validity,
      status,
    )
    if (status === 'review_required' && i.referenceKind === 'manual')
      db.prepare(
        "UPDATE evidence_links SET validity='invalid' WHERE project_id=? AND task_id=? AND id=?",
      ).run(i.projectId, i.taskId, i.referenceId)
  }
  function observe(projectId: string, eventId: number) {
    const e = db
      .prepare(
        'SELECT e.source_id,e.external_id FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id=?',
      )
      .get(projectId, eventId) as
      | { source_id: string; external_id: string }
      | undefined
    if (!e) throw Error('INVALID_REFERENCE_REVIEW')
    for (const kind of ['processing', 'manual'] as const) {
      const table =
        kind === 'processing' ? 'processing_evidence' : 'evidence_links'
      const refs = db
        .prepare(
          `SELECT v.task_id AS taskId,CAST(v.id AS TEXT) AS referenceId FROM ${table} v JOIN source_events e ON e.id=v.event_id WHERE v.project_id=? AND e.source_id=? AND e.external_id=?`,
        )
        .all(projectId, e.source_id, e.external_id) as {
        taskId: string
        referenceId: string
      }[]
      for (const ref of refs)
        reconcile({ projectId, ...ref, referenceKind: kind })
    }
  }
  function reviewReference(
    i: ReferenceInput & { cursor?: string; limit?: number },
  ): RevisionReview {
    const ref = reference(i),
      set = contents(i.projectId, ref.sourceId, ref.externalId),
      row = stored(i)
    if (
      !row ||
      row.content_digest !== set.digest ||
      (row.status === 'available' && set.count > 1) ||
      (row.status === 'review_required' && set.count < 2)
    )
      throw Error('INVALID_REFERENCE_REVIEW')
    const limit = i.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw Error('INVALID_REFERENCE_REVIEW')
    let offset = 0
    if (i.cursor !== undefined) {
      const match = /^([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(i.cursor)
      if (!match || match[1] !== set.digest)
        throw Error('REFERENCE_REVIEW_CONFLICT')
      offset = Number(match[2])
      if (!Number.isSafeInteger(offset) || offset > set.eventCount)
        throw Error('INVALID_REFERENCE_REVIEW')
    }
    const confirmation = row?.selected_event_id
      ? (db
          .prepare(
            `SELECT d.chosen_event_id AS eventId,e.revision,e.content AS text,e.role,d.reason,d.created_at AS createdAt,d.actor_id AS actorId FROM reference_revision_decisions d JOIN source_events e ON e.id=d.chosen_event_id WHERE d.project_id=? AND d.reference_kind=? AND d.reference_id=? AND d.reference_version=? AND d.chosen_event_id=? AND d.content_digest=? AND d.task_id=? AND e.source_id=? AND e.external_id=? AND e.operation='upsert' AND EXISTS(SELECT 1 FROM event_projects ep WHERE ep.event_id=e.id AND ep.project_id=d.project_id)`,
          )
          .get(
            i.projectId,
            i.referenceKind,
            i.referenceId,
            row.version,
            row.selected_event_id,
            set.digest,
            i.taskId,
            ref.sourceId,
            ref.externalId,
          ) as NonNullable<RevisionReview['confirmation']> | undefined)
      : undefined
    if (row?.status === 'confirmed' && !confirmation)
      throw Error('INVALID_REFERENCE_REVIEW')
    const page: RevisionReview['events'] = []
    let bytes = 0
    for (const event of db
      .prepare(
        `SELECT e.id,e.revision,e.occurred_at AS occurredAt,e.received_at AS receivedAt,e.content AS text,e.role,'upsert' AS operation FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.source_id=? AND e.external_id=? AND e.operation='upsert' ORDER BY e.id LIMIT ? OFFSET ?`,
      )
      .iterate(
        i.projectId,
        ref.sourceId,
        ref.externalId,
        limit,
        offset,
      ) as Iterable<RevisionReview['events'][number]>) {
      const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
      if (bytes + size > 512 * 1024) break
      page.push(event)
      bytes += size
    }
    const invalid =
      !!createRetractions(db).forEvent(i.projectId, ref.eventId) ||
      (i.referenceKind === 'manual' &&
        (row?.prior_validity ?? ref.validity) === 'invalid')
    const selectedSameContent = row?.selected_event_id
      ? !!db
          .prepare(
            'SELECT 1 FROM source_events a JOIN source_events b ON a.content=b.content AND a.role=b.role WHERE a.id=? AND b.id=?',
          )
          .get(ref.eventId, row.selected_event_id)
      : false
    const originalInvalid =
      invalid ||
      row?.status === 'review_required' ||
      (row?.status === 'confirmed' && !selectedSameContent)
    return {
      reference: {
        originalReferenceStatus: originalInvalid ? 'invalidated' : 'available',
        kind: i.referenceKind,
        id: i.referenceId,
        version: row?.version ?? 1,
        eventId: ref.eventId,
        sourceInstanceId: ref.sourceId,
        externalId: ref.externalId,
        status: invalid
          ? 'invalidated'
          : (row?.status ?? (set.count > 1 ? 'review_required' : 'available')),
      },
      knownContentSetDigest: set.digest,
      confirmedEventId: row?.selected_event_id ?? null,
      confirmation: confirmation
        ? {
            ...confirmation,
            validity: invalid
              ? 'invalid'
              : (row!.prior_validity as 'available' | 'valid' | 'unknown'),
          }
        : null,
      events: page,
      nextCursor:
        offset + page.length < set.eventCount
          ? `${set.digest}:${offset + page.length}`
          : null,
    }
  }
  const confirm = db.transaction(
    (
      i: ReferenceInput & {
        chosenEventId: number
        knownContentSetDigest: string
        expectedReferenceVersion: number
        reason: string
      },
      actorId: string,
    ) => {
      if (
        typeof actorId !== 'string' ||
        !actorId.trim() ||
        actorId.length > 256 ||
        typeof i.reason !== 'string' ||
        !i.reason.trim() ||
        i.reason.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(i.reason)
      )
        throw Error('INVALID_REFERENCE_REVIEW')
      const ref = reference(i)
      if (createRetractions(db).forEvent(i.projectId, ref.eventId))
        throw Error('REFERENCE_RETRACTED')
      const view = reviewReference(i),
        row = stored(i)!
      if (view.reference.status === 'invalidated')
        throw Error('REFERENCE_ALREADY_INVALID')
      if (
        i.knownContentSetDigest !== view.knownContentSetDigest ||
        i.expectedReferenceVersion !== view.reference.version
      )
        throw Error('REFERENCE_REVIEW_CONFLICT')
      const set = contents(i.projectId, ref.sourceId, ref.externalId)
      if (
        !db
          .prepare(
            `SELECT 1 FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.source_id=? AND e.external_id=? AND e.operation='upsert' AND e.id=?`,
          )
          .get(i.projectId, ref.sourceId, ref.externalId, i.chosenEventId)
      )
        throw Error('INVALID_REFERENCE_REVIEW')
      const version = row.version + 1
      db.prepare(
        "UPDATE reference_revision_reviews SET version=?,selected_event_id=?,status='confirmed' WHERE project_id=? AND reference_kind=? AND reference_id=?",
      ).run(
        version,
        i.chosenEventId,
        i.projectId,
        i.referenceKind,
        i.referenceId,
      )
      db.prepare(
        'INSERT INTO reference_revision_decisions(project_id,task_id,reference_kind,reference_id,reference_version,chosen_event_id,content_digest,actor_id,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        i.projectId,
        i.taskId,
        i.referenceKind,
        i.referenceId,
        version,
        i.chosenEventId,
        set.digest,
        actorId,
        i.reason,
        new Date().toISOString(),
      )
      const sameContent = !!db
        .prepare(
          'SELECT 1 FROM source_events a JOIN source_events b ON a.content=b.content AND a.role=b.role WHERE a.id=? AND b.id=?',
        )
        .get(ref.eventId, i.chosenEventId)
      if (i.referenceKind === 'manual')
        db.prepare(
          'UPDATE evidence_links SET validity=? WHERE project_id=? AND task_id=? AND id=?',
        ).run(
          sameContent ? row.prior_validity : 'invalid',
          i.projectId,
          i.taskId,
          i.referenceId,
        )
      return reviewReference(i)
    },
  )
  function listReferences(i: {
    projectId: string
    taskId: string
    cursor?: string
    limit?: number
  }) {
    const limit = i.limit ?? 20
    const offset = i.cursor === undefined ? 0 : Number(i.cursor)
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (i.cursor !== undefined && !/^(0|[1-9][0-9]*)$/.test(i.cursor))
    )
      throw Error('INVALID_REFERENCE_REVIEW')
    if (
      !db
        .prepare('SELECT 1 FROM tasks WHERE project_id=? AND id=?')
        .get(i.projectId, i.taskId)
    )
      throw Error('INVALID_REFERENCE_REVIEW')
    const refs = db
      .prepare(
        `SELECT 'processing' AS kind,CAST(id AS TEXT) AS id FROM processing_evidence WHERE project_id=? AND task_id=? UNION ALL SELECT 'manual',id FROM evidence_links WHERE project_id=? AND task_id=? ORDER BY kind,id LIMIT ? OFFSET ?`,
      )
      .all(i.projectId, i.taskId, i.projectId, i.taskId, limit + 1, offset) as {
      kind: ReferenceKind
      id: string
    }[]
    return {
      references: refs.slice(0, limit).map(
        (ref) =>
          reviewReference({
            ...i,
            cursor: undefined,
            limit: 1,
            referenceKind: ref.kind,
            referenceId: ref.id,
          }).reference,
      ),
      nextCursor: refs.length > limit ? String(offset + limit) : null,
    }
  }
  return { observe, reviewReference, confirmReference: confirm, listReferences }
}

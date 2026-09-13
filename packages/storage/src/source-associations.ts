import type Database from 'better-sqlite3'
import { randomUUID, createHash } from 'node:crypto'
import { parseSourceEvent } from '@memo/contracts'
import { normalizeIdentity, parseContextTimestamp } from '@memo/domain'
import { eventMetadataFields } from './event-metadata'
import { createTaskModel } from './task-model'
import { createRetractions } from './retractions'
import { getSourceStatus } from './source-status'

export interface ScopedAuthor {
  sourceInstanceId: string
  namespace: string
  subjectId: string
}
export interface SourceBinding {
  id: string
  projectId: string
  taskId: string
  sourceInstanceId: string
  externalId: string
  baselineEventId: number
  version: number
  active: boolean
  origin: 'manual' | 'rule'
  primary: boolean
}
export interface IdentityMapping {
  id: string
  projectId: string
  taskId: string
  leftEventId: number
  rightEventId: number
  left: ScopedAuthor
  right: ScopedAuthor
  version: number
  active: boolean
}
export interface AssociationAudit {
  id: number
  projectId: string
  taskId: string
  kind: 'source_binding' | 'identity_mapping'
  entityId: string
  version: number
  action: 'bind' | 'confirm' | 'revoke'
  recordedAt: string
  actorId: string
  reason: string
  before: SourceBinding | IdentityMapping | null
  after: SourceBinding | IdentityMapping
}
type BindingRow = {
  id: string
  project_id: string
  task_id: string
  source_id: string
  external_id: string
  event_id: number
  version: number
  active: number
}
type MappingRow = {
  id: string
  project_id: string
  task_id: string
  left_event_id: number
  right_event_id: number
  left_key: string
  right_key: string
  version: number
  active: number
}
type EventRow = {
  id: number
  source_id: string
  external_id: string
  revision: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  operation: 'upsert' | 'retract'
  content: string
  occurred_at: string
  received_at: string
  metadata_json: string | null
}
function fail(code = 'ASSOCIATION_CORRUPT_DATA'): never {
  throw Error(code)
}
function identifier(v: unknown): asserts v is string {
  if (
    typeof v !== 'string' ||
    !v.length ||
    v.length > 256 ||
    /[\s\u0000-\u001f\u007f]/u.test(v)
  )
    fail('ASSOCIATION_INVALID_INPUT')
}
function integer(v: unknown, min = 1): asserts v is number {
  if (!Number.isSafeInteger(v) || Number(v) < min)
    fail('ASSOCIATION_INVALID_INPUT')
}
function reason(v: unknown): asserts v is string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(v)
  )
    fail('ASSOCIATION_INVALID_INPUT')
}
export function migrateSourceAssociations(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
CREATE TABLE source_object_bindings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,source_id TEXT NOT NULL,external_id TEXT NOT NULL,event_id INTEGER NOT NULL,version INTEGER NOT NULL CHECK(version>=1),active INTEGER NOT NULL CHECK(active IN(0,1)),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(project_id,event_id) REFERENCES event_projects(project_id,event_id));
CREATE UNIQUE INDEX source_binding_active ON source_object_bindings(project_id,source_id,external_id) WHERE active=1;
CREATE INDEX source_binding_task ON source_object_bindings(project_id,task_id);
CREATE TABLE task_source_anchors(project_id TEXT NOT NULL,task_id TEXT NOT NULL,event_id INTEGER NOT NULL,PRIMARY KEY(project_id,task_id),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(project_id,event_id) REFERENCES event_projects(project_id,event_id));
CREATE TABLE explicit_identity_mappings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,left_event_id INTEGER NOT NULL,right_event_id INTEGER NOT NULL,left_key TEXT NOT NULL,right_key TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),active INTEGER NOT NULL CHECK(active IN(0,1)),UNIQUE(project_id,left_key,right_key),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(project_id,left_event_id) REFERENCES event_projects(project_id,event_id),FOREIGN KEY(project_id,right_event_id) REFERENCES event_projects(project_id,event_id));
CREATE TABLE source_association_audit(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,task_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('source_binding','identity_mapping')),entity_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),action TEXT NOT NULL CHECK(action IN('bind','confirm','revoke')),recorded_at TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,UNIQUE(kind,entity_id,version),FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
CREATE INDEX association_audit_task ON source_association_audit(project_id,task_id,id);
PRAGMA user_version=17;`),
  )()
}
export function createSourceAssociations(db: Database.Database) {
  const tasks = createTaskModel(db)
  function project(p: string) {
    identifier(p)
    if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(p))
      fail('ASSOCIATION_NOT_FOUND')
  }
  function task(p: string, t: string) {
    project(p)
    identifier(t)
    const v = tasks.get(p, t)
    if (!v) fail('ASSOCIATION_NOT_FOUND')
    return v
  }
  function event(p: string, n: number): EventRow {
    integer(n)
    const e = db
      .prepare(
        'SELECT e.* FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id=?',
      )
      .get(p, n) as EventRow | undefined
    if (!e) fail('ASSOCIATION_NOT_FOUND')
    try {
      parseSourceEvent({
        schemaVersion: 1,
        sourceInstanceId: e.source_id,
        externalId: e.external_id,
        revision: e.revision,
        role: e.role,
        operation: e.operation,
        text: e.content,
        occurredAt: e.occurred_at,
        ...eventMetadataFields(e.metadata_json),
      })
      parseContextTimestamp(e.occurred_at)
      parseContextTimestamp(e.received_at)
    } catch {
      fail()
    }
    return e
  }
  function author(p: string, n: number): ScopedAuthor | null {
    const e = event(p, n),
      a = eventMetadataFields(e.metadata_json).metadata?.author
    return a ? { sourceInstanceId: e.source_id, ...a } : null
  }
  function key(p: string, a: ScopedAuthor) {
    try {
      return normalizeIdentity({ ...a, projectId: p }).key
    } catch {
      fail('ASSOCIATION_UNAVAILABLE')
    }
  }
  function available(p: string, n: number) {
    const e = event(p, n)
    if (
      e.operation !== 'upsert' ||
      getSourceStatus(db, p, e.source_id) !== 'active' ||
      createRetractions(db).forEvent(p, n)
    )
      fail('ASSOCIATION_UNAVAILABLE')
    const siblings = db
      .prepare(
        `SELECT DISTINCT content,role,metadata_json FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.source_id=? AND e.external_id=? AND e.operation='upsert' LIMIT 102`,
      )
      .all(p, e.source_id, e.external_id) as {
      content: string
      role: string
      metadata_json: string | null
    }[]
    if (siblings.length > 100) fail('ASSOCIATION_LIMIT_EXCEEDED')
    const a = eventMetadataFields(e.metadata_json).metadata?.author
    for (const s of siblings) {
      const b = eventMetadataFields(s.metadata_json).metadata?.author
      if (
        s.content !== e.content ||
        s.role !== e.role ||
        (a && b && JSON.stringify(a) !== JSON.stringify(b))
      )
        fail('ASSOCIATION_UNAVAILABLE')
    }
    return e
  }
  function primaryEventId(p: string, t: string): number | null {
    task(p, t)
    const rule = db
      .prepare(
        'SELECT event_id FROM processing_evidence WHERE project_id=? AND task_id=? ORDER BY id LIMIT 1',
      )
      .get(p, t) as { event_id: number } | undefined
    const saved = db
      .prepare(
        'SELECT event_id FROM task_source_anchors WHERE project_id=? AND task_id=?',
      )
      .get(p, t) as { event_id: number } | undefined
    const n = saved?.event_id ?? rule?.event_id ?? null
    if (n !== null) event(p, n)
    return n
  }
  function binding(r: BindingRow): SourceBinding {
    if (
      ![0, 1].includes(r.active) ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1
    )
      fail()
    const e = event(r.project_id, r.event_id)
    if (e.source_id !== r.source_id || e.external_id !== r.external_id) fail()
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      sourceInstanceId: r.source_id,
      externalId: r.external_id,
      baselineEventId: r.event_id,
      version: r.version,
      active: !!r.active,
      origin: 'manual',
      primary: primaryEventId(r.project_id, r.task_id) === r.event_id,
    }
  }
  function rules(
    p: string,
    t?: string,
    source?: string,
    external?: string,
  ): SourceBinding[] {
    const rows = db
      .prepare(
        `SELECT o.rowid AS rid,o.*,(SELECT pe.event_id FROM processing_evidence pe JOIN source_events e ON e.id=pe.event_id WHERE pe.project_id=o.project_id AND pe.task_id=o.task_id AND e.source_id=o.source_id AND e.external_id=o.external_id ORDER BY pe.id LIMIT 1) AS event_id FROM processing_origins o WHERE o.project_id=? ${t ? 'AND o.task_id=?' : ''} ${source !== undefined ? 'AND o.source_id=? AND o.external_id=?' : ''} ORDER BY o.rowid LIMIT 101`,
      )
      .all(
        p,
        ...(t ? [t] : []),
        ...(source !== undefined ? [source, external!] : []),
      ) as {
      rid: number
      task_id: string
      source_id: string
      external_id: string
      event_id: number
    }[]
    if (rows.length > 100) fail('ASSOCIATION_LIMIT_EXCEEDED')
    return rows
      .filter(
        (r, index) =>
          rows.findIndex(
            (x) =>
              x.task_id === r.task_id &&
              x.source_id === r.source_id &&
              x.external_id === r.external_id,
          ) === index,
      )
      .map((r) => {
        event(p, r.event_id)
        return {
          id: `rule:${createHash('sha256')
            .update(JSON.stringify([p, r.task_id, r.source_id, r.external_id]))
            .digest('hex')}`,
          projectId: p,
          taskId: r.task_id,
          sourceInstanceId: r.source_id,
          externalId: r.external_id,
          baselineEventId: r.event_id,
          version: 1,
          active: true,
          origin: 'rule',
          primary: primaryEventId(p, r.task_id) === r.event_id,
        }
      })
  }
  function sourceBindings(input: { projectId: string; taskId: string }) {
    const { projectId: p, taskId: t } = input
    task(p, t)
    const rows = db
      .prepare(
        'SELECT * FROM source_object_bindings WHERE project_id=? AND task_id=? ORDER BY rowid LIMIT 101',
      )
      .all(p, t) as BindingRow[]
    const bindings = [...rules(p, t), ...rows.map(binding)]
    if (bindings.length > 100) fail('ASSOCIATION_LIMIT_EXCEEDED')
    return { bindings, primaryEventId: primaryEventId(p, t) }
  }
  function resolveObject(
    p: string,
    s: string,
    x: string,
  ): SourceBinding | null {
    project(p)
    const r = rules(p, undefined, s, x)
    const m = (
      db
        .prepare(
          'SELECT * FROM source_object_bindings WHERE project_id=? AND source_id=? AND external_id=? AND active=1 LIMIT 2',
        )
        .all(p, s, x) as BindingRow[]
    ).map(binding)
    const all = [...r, ...m]
    if (new Set(all.map((v) => v.taskId)).size > 1) fail('ASSOCIATION_CONFLICT')
    return all[0] ?? null
  }
  function auditWrite(
    p: string,
    t: string,
    kind: AssociationAudit['kind'],
    action: AssociationAudit['action'],
    before: AssociationAudit['before'],
    after: AssociationAudit['after'],
    actor: string,
    why: string,
  ) {
    identifier(actor)
    if (actor === 'automatic') fail('ASSOCIATION_INVALID_INPUT')
    reason(why)
    db.prepare(
      'INSERT INTO source_association_audit(project_id,task_id,kind,entity_id,version,action,recorded_at,actor_id,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      p,
      t,
      kind,
      after.id,
      after.version,
      action,
      new Date().toISOString(),
      actor,
      why,
      before ? JSON.stringify(before) : null,
      JSON.stringify(after),
    )
  }
  function bindSourceObject(
    i: {
      projectId: string
      taskId: string
      eventId: number
      expectedTaskVersion: number
      expectedCriteriaVersion: number
      expectedManualVersion: number
      reason: string
    },
    actor: string,
  ) {
    return db
      .transaction(() => {
        const t = task(i.projectId, i.taskId)
        integer(i.expectedTaskVersion)
        integer(i.expectedCriteriaVersion, 0)
        integer(i.expectedManualVersion, 0)
        if (
          t.version !== i.expectedTaskVersion ||
          t.criteriaVersion !== i.expectedCriteriaVersion ||
          t.manualVersion !== i.expectedManualVersion
        )
          fail('ASSOCIATION_CONFLICT')
        const e = available(i.projectId, i.eventId)
        if (resolveObject(i.projectId, e.source_id, e.external_id))
          fail('ASSOCIATION_CONFLICT')
        if (sourceBindings(i).bindings.length >= 100)
          fail('ASSOCIATION_LIMIT_EXCEEDED')
        const id = randomUUID()
        db.prepare(
          'INSERT INTO source_object_bindings VALUES(?,?,?,?,?,?,1,1)',
        ).run(id, i.projectId, i.taskId, e.source_id, e.external_id, e.id)
        if (primaryEventId(i.projectId, i.taskId) === null)
          db.prepare('INSERT INTO task_source_anchors VALUES(?,?,?)').run(
            i.projectId,
            i.taskId,
            e.id,
          )
        const out = sourceBindings(i),
          after = out.bindings.find((b) => b.id === id)!
        auditWrite(
          i.projectId,
          i.taskId,
          'source_binding',
          'bind',
          null,
          after,
          actor,
          i.reason,
        )
        return out
      })
      .immediate()
  }
  function revokeSourceBinding(
    i: {
      projectId: string
      taskId: string
      id: string
      expectedVersion: number
      reason: string
    },
    actor: string,
  ) {
    return db
      .transaction(() => {
        integer(i.expectedVersion)
        const b = sourceBindings(i).bindings.find((v) => v.id === i.id)
        if (!b) fail('ASSOCIATION_NOT_FOUND')
        if (b.origin === 'rule' || !b.active || b.version !== i.expectedVersion)
          fail('ASSOCIATION_CONFLICT')
        db.prepare(
          'UPDATE source_object_bindings SET active=0,version=version+1 WHERE id=?',
        ).run(b.id)
        const after = { ...b, active: false, version: b.version + 1 }
        auditWrite(
          i.projectId,
          i.taskId,
          'source_binding',
          'revoke',
          b,
          after,
          actor,
          i.reason,
        )
        return sourceBindings(i)
      })
      .immediate()
  }
  function mapping(r: MappingRow): IdentityMapping {
    const left = author(r.project_id, r.left_event_id),
      right = author(r.project_id, r.right_event_id)
    if (
      !left ||
      !right ||
      key(r.project_id, left) !== r.left_key ||
      key(r.project_id, right) !== r.right_key ||
      r.left_key >= r.right_key ||
      ![0, 1].includes(r.active) ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1
    )
      fail()
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      leftEventId: r.left_event_id,
      rightEventId: r.right_event_id,
      left,
      right,
      version: r.version,
      active: !!r.active,
    }
  }
  function projectMappings(p: string) {
    const rows = db
      .prepare(
        'SELECT * FROM explicit_identity_mappings WHERE project_id=? ORDER BY rowid LIMIT 101',
      )
      .all(p) as MappingRow[]
    if (rows.length > 100) fail('ASSOCIATION_LIMIT_EXCEEDED')
    return rows.map(mapping)
  }
  function identityMappings(i: { projectId: string; taskId: string }) {
    const b = sourceBindings(i).bindings,
      keys = new Set(
        b
          .map((v) => author(i.projectId, v.baselineEventId))
          .filter((v): v is ScopedAuthor => !!v)
          .map((v) => key(i.projectId, v)),
      )
    return {
      mappings: projectMappings(i.projectId).filter(
        (m) =>
          m.taskId === i.taskId ||
          (keys.has(key(i.projectId, m.left)) &&
            keys.has(key(i.projectId, m.right))),
      ),
    }
  }
  function confirmIdentityMapping(
    i: {
      projectId: string
      taskId: string
      leftEventId: number
      rightEventId: number
      expectedLeftBindingVersion: number
      expectedRightBindingVersion: number
      expectedMappingVersion: number
      reason: string
    },
    actor: string,
  ) {
    return db
      .transaction(() => {
        task(i.projectId, i.taskId)
        integer(i.expectedLeftBindingVersion)
        integer(i.expectedRightBindingVersion)
        integer(i.expectedMappingVersion, 0)
        if (i.leftEventId === i.rightEventId) fail('ASSOCIATION_INVALID_INPUT')
        const le = available(i.projectId, i.leftEventId),
          re = available(i.projectId, i.rightEventId)
        const lb = resolveObject(i.projectId, le.source_id, le.external_id),
          rb = resolveObject(i.projectId, re.source_id, re.external_id)
        if (
          !lb ||
          !rb ||
          lb.taskId !== i.taskId ||
          rb.taskId !== i.taskId ||
          lb.version !== i.expectedLeftBindingVersion ||
          rb.version !== i.expectedRightBindingVersion
        )
          fail('ASSOCIATION_CONFLICT')
        const l = author(i.projectId, le.id),
          r = author(i.projectId, re.id)
        if (!l || !r) fail('ASSOCIATION_UNAVAILABLE')
        let lk = key(i.projectId, l),
          rk = key(i.projectId, r),
          li = le.id,
          ri = re.id
        if (lk === rk) fail('ASSOCIATION_INVALID_INPUT')
        if (lk > rk) {
          ;[lk, rk] = [rk, lk]
          ;[li, ri] = [ri, li]
        }
        const old = db
          .prepare(
            'SELECT * FROM explicit_identity_mappings WHERE project_id=? AND left_key=? AND right_key=?',
          )
          .get(i.projectId, lk, rk) as MappingRow | undefined
        if (old?.active || (old?.version ?? 0) !== i.expectedMappingVersion)
          fail('ASSOCIATION_CONFLICT')
        if (old) {
          const before = mapping(old)
          db.prepare(
            'UPDATE explicit_identity_mappings SET active=1,version=version+1 WHERE id=?',
          ).run(old.id)
          const after = { ...before, active: true, version: before.version + 1 }
          auditWrite(
            i.projectId,
            i.taskId,
            'identity_mapping',
            'confirm',
            before,
            after,
            actor,
            i.reason,
          )
          return identityMappings(i)
        }
        if (projectMappings(i.projectId).length >= 100)
          fail('ASSOCIATION_LIMIT_EXCEEDED')
        const id = randomUUID()
        db.prepare(
          'INSERT INTO explicit_identity_mappings VALUES(?,?,?,?,?,?,?,1,1)',
        ).run(id, i.projectId, i.taskId, li, ri, lk, rk)
        const after = mapping(
          db
            .prepare('SELECT * FROM explicit_identity_mappings WHERE id=?')
            .get(id) as MappingRow,
        )
        auditWrite(
          i.projectId,
          i.taskId,
          'identity_mapping',
          'confirm',
          null,
          after,
          actor,
          i.reason,
        )
        return identityMappings(i)
      })
      .immediate()
  }
  function revokeIdentityMapping(
    i: {
      projectId: string
      taskId: string
      id: string
      expectedVersion: number
      reason: string
    },
    actor: string,
  ) {
    return db
      .transaction(() => {
        integer(i.expectedVersion)
        const before = identityMappings(i).mappings.find((m) => m.id === i.id)
        if (!before) fail('ASSOCIATION_NOT_FOUND')
        if (!before.active || before.version !== i.expectedVersion)
          fail('ASSOCIATION_CONFLICT')
        db.prepare(
          'UPDATE explicit_identity_mappings SET active=0,version=version+1 WHERE id=?',
        ).run(i.id)
        const after = { ...before, version: before.version + 1, active: false }
        auditWrite(
          i.projectId,
          i.taskId,
          'identity_mapping',
          'revoke',
          before,
          after,
          actor,
          i.reason,
        )
        return identityMappings(i)
      })
      .immediate()
  }
  function matchAuthors(p: string, l: number, r: number) {
    const a = author(p, l),
      b = author(p, r)
    if (!a || !b)
      return { matched: false, mappingId: null, mappingVersion: null }
    const ak = key(p, a),
      bk = key(p, b)
    if (ak === bk)
      return { matched: true, mappingId: null, mappingVersion: null }
    const row = db
      .prepare(
        'SELECT * FROM explicit_identity_mappings WHERE project_id=? AND left_key=? AND right_key=? AND active=1',
      )
      .get(p, ...[ak, bk].sort()) as MappingRow | undefined
    if (!row) return { matched: false, mappingId: null, mappingVersion: null }
    const m = mapping(row)
    return { matched: true, mappingId: m.id, mappingVersion: m.version }
  }
  function bindingCurrent(p: string, t: string, id: string, version: number) {
    return sourceBindings({ projectId: p, taskId: t }).bindings.some(
      (b) => b.id === id && b.version === version && b.active,
    )
  }
  function mappingCurrent(p: string, id: string, version: number) {
    project(p)
    const row = db
      .prepare(
        'SELECT * FROM explicit_identity_mappings WHERE project_id=? AND id=?',
      )
      .get(p, id) as MappingRow | undefined
    return !!row && mapping(row).active && row.version === version
  }
  function sourceEvents(i: {
    projectId: string
    sourceInstanceId?: string
    cursor?: string
    limit?: number
  }) {
    project(i.projectId)
    const limit = i.limit ?? 20
    integer(limit)
    if (limit > 50) fail('ASSOCIATION_INVALID_INPUT')
    if (i.sourceInstanceId !== undefined) identifier(i.sourceInstanceId)
    let ceiling = (
        db
          .prepare(
            'SELECT COALESCE(MAX(event_id),0) n FROM event_projects WHERE project_id=?',
          )
          .get(i.projectId) as { n: number }
      ).n,
      after = ceiling + 1
    if (i.cursor !== undefined) {
      try {
        if (i.cursor.length > 4096) fail()
        const c = JSON.parse(
          Buffer.from(i.cursor, 'base64url').toString('utf8'),
        )
        if (
          JSON.stringify(Object.keys(c).sort()) !==
            JSON.stringify(['after', 'ceiling', 'project', 'source', 'v']) ||
          c.v !== 1 ||
          c.project !== i.projectId ||
          c.source !== (i.sourceInstanceId ?? null)
        )
          fail()
        integer(c.ceiling, 0)
        integer(c.after)
        ceiling = c.ceiling
        after = c.after
        if (after > ceiling + 1) fail()
      } catch {
        fail('ASSOCIATION_INVALID_CURSOR')
      }
    }
    const rows = db
      .prepare(
        `SELECT e.id FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id<=? AND e.id<? ${i.sourceInstanceId ? 'AND e.source_id=?' : ''} ORDER BY e.id DESC LIMIT ?`,
      )
      .all(
        i.projectId,
        ceiling,
        after,
        ...(i.sourceInstanceId ? [i.sourceInstanceId] : []),
        limit + 1,
      ) as { id: number }[]
    const events = rows.slice(0, limit).map((r) => {
      const e = event(i.projectId, r.id),
        chars = Array.from(e.content)
      return {
        id: e.id,
        sourceInstanceId: e.source_id,
        externalId: e.external_id,
        revision: e.revision,
        role: e.role,
        operation: e.operation,
        occurredAt: e.occurred_at,
        receivedAt: e.received_at,
        excerpt: chars.slice(0, 1024).join(''),
        excerptTruncated: chars.length > 1024,
        author: author(i.projectId, e.id),
        sourceStatus: getSourceStatus(db, i.projectId, e.source_id),
      }
    })
    return {
      events,
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                project: i.projectId,
                source: i.sourceInstanceId ?? null,
                ceiling,
                after: events.at(-1)!.id,
              }),
            ).toString('base64url')
          : null,
    }
  }
  function audit(id: number) {
    const row = db
      .prepare('SELECT * FROM source_association_audit WHERE id=?')
      .get(id)
    if (!row) fail('ASSOCIATION_NOT_FOUND')
    return validateAssociationAudit(db, row)
  }
  function exportForTasks(
    p: string,
    ids: string[],
    _includeSourceText: boolean,
  ) {
    project(p)
    if (!Array.isArray(ids) || ids.length > 1000)
      fail('ASSOCIATION_INVALID_INPUT')
    const bindings: SourceBinding[] = [],
      mappings = new Map<string, IdentityMapping>(),
      audits: AssociationAudit[] = []
    for (const t of ids) {
      bindings.push(...sourceBindings({ projectId: p, taskId: t }).bindings)
      for (const m of identityMappings({ projectId: p, taskId: t }).mappings)
        mappings.set(m.id, m)
      const rows = db
        .prepare(
          'SELECT * FROM source_association_audit WHERE project_id=? AND task_id=? ORDER BY id LIMIT 10001',
        )
        .all(p, t)
      if (rows.length > 10000 || audits.length + rows.length > 10000)
        fail('ASSOCIATION_LIMIT_EXCEEDED')
      audits.push(...rows.map((r) => validateAssociationAudit(db, r)))
    }
    for (const m of mappings.values()) {
      const rows = db
        .prepare(
          "SELECT * FROM source_association_audit WHERE project_id=? AND kind='identity_mapping' AND entity_id=? ORDER BY id LIMIT 10001",
        )
        .all(p, m.id)
      if (rows.length > 10000) fail('ASSOCIATION_LIMIT_EXCEEDED')
      for (const row of rows) {
        const a = validateAssociationAudit(db, row)
        if (!audits.some((v) => v.id === a.id)) audits.push(a)
      }
      if (audits.length > 10000) fail('ASSOCIATION_LIMIT_EXCEEDED')
    }
    return {
      bindings,
      mappings: [...mappings.values()],
      audits: audits.sort((a, b) => a.id - b.id),
    }
  }
  return {
    sourceEvents,
    sourceBindings,
    bindSourceObject,
    revokeSourceBinding,
    identityMappings,
    confirmIdentityMapping,
    revokeIdentityMapping,
    resolveObject,
    primaryEventId,
    matchAuthors,
    bindingCurrent,
    mappingCurrent,
    exportForTasks,
    audit,
  }
}
export function validateAssociationAudit(
  db: Database.Database,
  raw: unknown,
): AssociationAudit {
  try {
    const r = raw as Record<string, unknown>
    integer(r.id)
    identifier(r.project_id)
    identifier(r.task_id)
    identifier(r.entity_id)
    integer(r.version)
    identifier(r.actor_id)
    reason(r.reason)
    parseContextTimestamp(r.recorded_at)
    if (
      !['source_binding', 'identity_mapping'].includes(String(r.kind)) ||
      !['bind', 'confirm', 'revoke'].includes(String(r.action))
    )
      fail()
    if (
      typeof r.after_json !== 'string' ||
      r.after_json.length > 16384 ||
      (r.before_json !== null &&
        (typeof r.before_json !== 'string' || r.before_json.length > 16384))
    )
      fail()
    const after = JSON.parse(r.after_json) as AssociationAudit['after'],
      before =
        r.before_json === null
          ? null
          : (JSON.parse(r.before_json as string) as AssociationAudit['after'])
    if (
      after.id !== r.entity_id ||
      after.projectId !== r.project_id ||
      after.version !== r.version ||
      typeof after.active !== 'boolean'
    )
      fail()
    const validate = (v: AssociationAudit['after']) => {
      const bindingKind = r.kind === 'source_binding'
      const allowed = bindingKind
        ? [
            'id',
            'projectId',
            'taskId',
            'sourceInstanceId',
            'externalId',
            'baselineEventId',
            'version',
            'active',
            'origin',
            'primary',
          ]
        : [
            'id',
            'projectId',
            'taskId',
            'leftEventId',
            'rightEventId',
            'left',
            'right',
            'version',
            'active',
          ]
      if (
        !v ||
        typeof v !== 'object' ||
        Object.keys(v).sort().join(',') !== allowed.sort().join(',')
      )
        fail()
      identifier(v.id)
      identifier(v.projectId)
      identifier(v.taskId)
      integer(v.version)
      if (v.projectId !== r.project_id || typeof v.active !== 'boolean') fail()
      if (bindingKind) {
        const b = v as SourceBinding
        if (
          b.origin !== 'manual' ||
          typeof b.primary !== 'boolean' ||
          b.primary !==
            (createSourceAssociations(db).primaryEventId(
              b.projectId,
              b.taskId,
            ) ===
              b.baselineEventId) ||
          b.taskId !== r.task_id
        )
          fail()
        const stored = db
          .prepare(
            'SELECT * FROM source_object_bindings WHERE id=? AND project_id=?',
          )
          .get(b.id, b.projectId) as BindingRow | undefined
        if (
          !stored ||
          stored.task_id !== b.taskId ||
          stored.source_id !== b.sourceInstanceId ||
          stored.external_id !== b.externalId ||
          stored.event_id !== b.baselineEventId ||
          stored.version < b.version ||
          (stored.version === b.version && !!stored.active !== b.active)
        )
          fail()
        const e = db
          .prepare('SELECT source_id,external_id FROM source_events WHERE id=?')
          .get(b.baselineEventId) as EventRow | undefined
        if (
          !e ||
          e.source_id !== b.sourceInstanceId ||
          e.external_id !== b.externalId
        )
          fail()
      } else {
        const m = v as IdentityMapping
        const stored = db
          .prepare(
            'SELECT * FROM explicit_identity_mappings WHERE id=? AND project_id=?',
          )
          .get(m.id, m.projectId) as MappingRow | undefined
        if (
          !stored ||
          stored.task_id !== m.taskId ||
          stored.left_event_id !== m.leftEventId ||
          stored.right_event_id !== m.rightEventId ||
          stored.version < m.version ||
          (stored.version === m.version && !!stored.active !== m.active)
        )
          fail()
        for (const [a, n, k] of [
          [m.left, m.leftEventId, stored.left_key],
          [m.right, m.rightEventId, stored.right_key],
        ] as const) {
          if (
            !a ||
            Object.keys(a).sort().join(',') !==
              'namespace,sourceInstanceId,subjectId'
          )
            fail()
          const e = db
            .prepare('SELECT * FROM source_events WHERE id=?')
            .get(n) as EventRow | undefined
          if (!e || e.source_id !== a.sourceInstanceId) fail()
          const au = eventMetadataFields(e.metadata_json).metadata?.author
          if (
            !au ||
            au.namespace !== a.namespace ||
            au.subjectId !== a.subjectId ||
            normalizeIdentity({ ...a, projectId: m.projectId }).key !== k
          )
            fail()
        }
      }
      const ids =
        'baselineEventId' in v
          ? [v.baselineEventId]
          : [v.leftEventId, v.rightEventId]
      for (const id of ids) {
        integer(id)
        if (
          !db
            .prepare(
              'SELECT 1 FROM event_projects WHERE project_id=? AND event_id=?',
            )
            .get(r.project_id, id)
        )
          fail()
      }
      if (
        !db
          .prepare('SELECT 1 FROM tasks WHERE project_id=? AND id=?')
          .get(v.projectId, v.taskId)
      )
        fail()
    }
    validate(after)
    if (
      !db
        .prepare('SELECT 1 FROM tasks WHERE project_id=? AND id=?')
        .get(r.project_id, r.task_id)
    )
      fail()
    const previous = db
      .prepare(
        'SELECT after_json FROM source_association_audit WHERE kind=? AND entity_id=? AND version=? AND project_id=?',
      )
      .get(r.kind, r.entity_id, Number(r.version) - 1, r.project_id) as
      | { after_json: string }
      | undefined
    if (
      Number(r.version) > 1 &&
      (!previous ||
        JSON.stringify(JSON.parse(previous.after_json)) !==
          JSON.stringify(before))
    )
      fail()
    if (before) {
      validate(before)
      if (
        before.id !== after.id ||
        before.projectId !== after.projectId ||
        before.version + 1 !== after.version ||
        before.active === after.active ||
        r.action !== (after.active ? 'confirm' : 'revoke')
      )
        fail()
      const a = { ...after, version: before.version, active: before.active }
      if (JSON.stringify(a) !== JSON.stringify(before)) fail()
    } else if (
      after.version !== 1 ||
      !after.active ||
      r.action !== (r.kind === 'source_binding' ? 'bind' : 'confirm')
    )
      fail()
    return {
      id: r.id as number,
      projectId: r.project_id as string,
      taskId: r.task_id as string,
      kind: r.kind as AssociationAudit['kind'],
      entityId: r.entity_id as string,
      version: r.version as number,
      action: r.action as AssociationAudit['action'],
      recordedAt: r.recorded_at as string,
      actorId: r.actor_id as string,
      reason: r.reason as string,
      before,
      after,
    }
  } catch {
    fail()
  }
}

import { createRevisionReview } from './revision-review'
import { createRetractions } from './retractions'
import type Database from 'better-sqlite3'
import {
  createCandidateSearch,
  projectionTerms,
  searchMatchExpression,
} from './search'

export type StoredTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'cancelled'
export type StoredAdmission = 'candidate' | 'accepted' | 'ignored'
export interface StoredTask {
  id: string
  projectId: string | null
  title: string
  owner: string | null
  status: StoredTaskStatus
  evidenceStatus: 'unknown' | 'partial' | 'sufficient' | 'conflict'
  admission: StoredAdmission
  version: number
  criteriaVersion: number
  manualVersion: number
  archivedAt: string | null
  dueAt: string | null
}
export interface ManualActor {
  actorId: string
  reason: string
}
export interface TaskExpectation {
  projectId: string
  taskId: string
  expectedVersion: number
  expectedCriteriaVersion: number
  expectedManualVersion: number
}
export interface CriterionInput {
  id: string
  description: string
  originEventId?: number
}
export interface EvidenceInput {
  id: string
  criterionId: string
  criteriaVersion: number
  eventId: number
  relation: 'supports' | 'opposes' | 'related'
  validity: 'unknown' | 'valid' | 'invalid'
  reason: string
}
export interface TaskPatch {
  title?: string
  owner?: string | null
  status?: StoredTaskStatus
  admission?: StoredAdmission
  archived?: boolean
  dueAt?: string | null
}
const selectTask = `SELECT id,project_id AS projectId,title,owner,status,evidence_status AS evidenceStatus,
  admission,version,criteria_version AS criteriaVersion,manual_version AS manualVersion,archived_at AS archivedAt,due_at AS dueAt FROM tasks`
function text(value: unknown, max = 256): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value.includes('\0')
  )
    throw new Error('INVALID_TASK_INPUT')
}
function integer(value: unknown, min = 1): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error('INVALID_TASK_INPUT')
}
function actor(value: ManualActor) {
  text(value.actorId)
  text(value.reason, 2048)
}
function choice(value: unknown, values: readonly string[]) {
  if (typeof value !== 'string' || !values.includes(value))
    throw new Error('INVALID_TASK_INPUT')
}

export interface TaskPageQuery {
  projectId?: string | null
  status?: StoredTaskStatus
  admission?: StoredAdmission
  archive?: 'active' | 'archived' | 'all'
  query?: string
  limit?: number
  cursor?: string
}
export interface TaskPage {
  items: StoredTask[]
  nextCursor: string | null
  totalCount: number
  activeCount: number
}
export interface TaskDecisionSummary {
  id: number
  scope: string
  actorId: string
  reason: string
  createdAt: string
  taskVersion: number
  criteriaVersion: number
}
function dueDate(value: unknown): string | null {
  if (value === null) return null
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    throw new Error('INVALID_DUE_DATE')
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_DUE_DATE')
  const normalized = date.toISOString()
  const padded = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`,
  )
  if (normalized !== padded) throw new Error('INVALID_DUE_DATE')
  return normalized
}
export function migrateTaskEditing(db: Database.Database) {
  db.transaction(() => {
    db.exec(`ALTER TABLE tasks ADD COLUMN due_at TEXT CHECK(due_at IS NULL OR (length(due_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',due_at) IS due_at));
      CREATE VIRTUAL TABLE task_listing_fts USING fts5(terms,tokenize='ascii');
      PRAGMA user_version=4;`)
    createTaskModel(db).rebuildSearch()
  })()
}

export function migrateTaskModel(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY CHECK(length(id)>0), name TEXT NOT NULL CHECK(length(name)>0));
    ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id);
    ALTER TABLE tasks ADD COLUMN owner TEXT;
    ALTER TABLE tasks ADD COLUMN admission TEXT NOT NULL DEFAULT 'candidate' CHECK(admission IN ('candidate','accepted','ignored'));
    ALTER TABLE tasks ADD COLUMN criteria_version INTEGER NOT NULL DEFAULT 0 CHECK(criteria_version>=0);
    ALTER TABLE tasks ADD COLUMN manual_version INTEGER NOT NULL DEFAULT 0 CHECK(manual_version>=0);
    CREATE UNIQUE INDEX tasks_id_project ON tasks(id,project_id);
    CREATE INDEX tasks_project_admission ON tasks(project_id,admission,archived_at);
    CREATE TABLE event_projects(project_id TEXT NOT NULL REFERENCES projects(id),event_id INTEGER NOT NULL REFERENCES source_events(id),PRIMARY KEY(project_id,event_id));
    CREATE TABLE criterion_sets(task_id TEXT NOT NULL REFERENCES tasks(id),version INTEGER NOT NULL CHECK(version>0),PRIMARY KEY(task_id,version));
    CREATE TABLE criteria(task_id TEXT NOT NULL,project_id TEXT NOT NULL,version INTEGER NOT NULL,criterion_id TEXT NOT NULL,
      description TEXT NOT NULL CHECK(length(description)>0),origin_event_id INTEGER,
      PRIMARY KEY(task_id,version,criterion_id),FOREIGN KEY(task_id,version) REFERENCES criterion_sets(task_id,version),
      FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(project_id,origin_event_id) REFERENCES event_projects(project_id,event_id));
    CREATE TABLE evidence_links(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,project_id TEXT NOT NULL,criterion_version INTEGER NOT NULL,criterion_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,relation TEXT NOT NULL CHECK(relation IN ('supports','opposes','related')),
      validity TEXT NOT NULL CHECK(validity IN ('unknown','valid','invalid')),reason TEXT NOT NULL CHECK(length(reason)>0),
      FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id),FOREIGN KEY(task_id,criterion_version,criterion_id) REFERENCES criteria(task_id,version,criterion_id),
      FOREIGN KEY(project_id,event_id) REFERENCES event_projects(project_id,event_id));
    CREATE TABLE decisions(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),actor TEXT NOT NULL CHECK(actor='manual'),actor_id TEXT NOT NULL,
      scope TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,task_version INTEGER NOT NULL,criteria_version INTEGER NOT NULL,manual_version INTEGER NOT NULL,
      input_refs TEXT NOT NULL,payload TEXT NOT NULL,supersedes INTEGER,UNIQUE(task_id,id),FOREIGN KEY(task_id,supersedes) REFERENCES decisions(task_id,id));
    CREATE TABLE manual_overrides(task_id TEXT NOT NULL REFERENCES tasks(id),scope TEXT NOT NULL,decision_id INTEGER NOT NULL,
      PRIMARY KEY(task_id,scope),FOREIGN KEY(task_id,decision_id) REFERENCES decisions(task_id,id));
    CREATE TABLE task_revisions(task_id TEXT NOT NULL REFERENCES tasks(id),version INTEGER NOT NULL,decision_id INTEGER,snapshot TEXT NOT NULL,
      PRIMARY KEY(task_id,version),FOREIGN KEY(task_id,decision_id) REFERENCES decisions(task_id,id));
    CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,decision_id INTEGER NOT NULL UNIQUE REFERENCES decisions(id),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered')),created_at TEXT NOT NULL,payload TEXT NOT NULL);
    -- v2 projections did not establish authoritative project membership for legacy tasks.
    DELETE FROM candidate_search_fts WHERE rowid IN (SELECT id FROM candidate_search_documents WHERE candidate_id IN (SELECT id FROM tasks));
    DELETE FROM candidate_search_documents WHERE candidate_id IN (SELECT id FROM tasks);
    PRAGMA user_version=3;
  `),
  )()
}

export function createTaskModel(db: Database.Database) {
  const search = createCandidateSearch(db)
  function read(taskId: string): StoredTask | undefined {
    return db.prepare(`${selectTask} WHERE id=?`).get(taskId) as
      | StoredTask
      | undefined
  }
  function requireTask(input: TaskExpectation) {
    text(input.projectId)
    text(input.taskId)
    integer(input.expectedVersion)
    integer(input.expectedCriteriaVersion, 0)
    integer(input.expectedManualVersion, 0)
    const task = read(input.taskId)
    if (!task || task.projectId !== input.projectId)
      throw new Error('TASK_NOT_IN_PROJECT')
    if (
      task.version !== input.expectedVersion ||
      task.criteriaVersion !== input.expectedCriteriaVersion ||
      task.manualVersion !== input.expectedManualVersion
    )
      throw new Error('VERSION_CONFLICT')
    return task
  }
  function eventInProject(projectId: string, eventId: number) {
    integer(eventId)
    if (
      !db
        .prepare(
          'SELECT 1 FROM event_projects WHERE project_id=? AND event_id=?',
        )
        .get(projectId, eventId)
    )
      throw new Error('EVENT_NOT_IN_PROJECT')
  }
  function sync(task: StoredTask) {
    const criteria = db
      .prepare(
        'SELECT description FROM criteria WHERE task_id=? AND version=? ORDER BY criterion_id',
      )
      .all(task.id, task.criteriaVersion) as { description: string }[]
    const body = criteria.map((c) => c.description).join('\n')
    const row = db
      .prepare('SELECT rowid AS rowId FROM tasks WHERE id=?')
      .get(task.id) as { rowId: number }
    db.prepare('DELETE FROM task_listing_fts WHERE rowid=?').run(row.rowId)
    db.prepare('INSERT INTO task_listing_fts(rowid,terms) VALUES(?,?)').run(
      row.rowId,
      projectionTerms({
        projectId: task.projectId ?? '',
        candidateId: task.id,
        title: task.title,
        text: body,
        codeIdentifiers: [],
      }),
    )
    if (task.projectId === null) return
    if (task.admission === 'ignored' || task.archivedAt !== null) {
      search.remove(task.projectId, task.id)
      return
    }
    search.upsert({
      projectId: task.projectId,
      candidateId: task.id,
      title: task.title,
      text: criteria.map((c) => c.description).join('\n'),
      codeIdentifiers: [],
    })
  }
  function record(
    taskId: string,
    by: ManualActor,
    scope: string,
    payload: unknown,
    inputRefs: number[] = [],
  ) {
    const task = read(taskId)!
    const previous = db
      .prepare(
        'SELECT decision_id AS id FROM manual_overrides WHERE task_id=? AND scope=?',
      )
      .get(taskId, scope) as { id: number } | undefined
    const result = db
      .prepare(
        `INSERT INTO decisions(task_id,actor,actor_id,scope,reason,created_at,task_version,criteria_version,manual_version,input_refs,payload,supersedes)
      VALUES(?,'manual',?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        taskId,
        by.actorId,
        scope,
        by.reason,
        new Date().toISOString(),
        task.version,
        task.criteriaVersion,
        task.manualVersion,
        JSON.stringify(inputRefs),
        JSON.stringify(payload),
        previous?.id ?? null,
      )
    const decisionId = Number(result.lastInsertRowid)
    db.prepare(
      'INSERT INTO manual_overrides(task_id,scope,decision_id) VALUES(?,?,?) ON CONFLICT(task_id,scope) DO UPDATE SET decision_id=excluded.decision_id',
    ).run(taskId, scope, decisionId)
    db.prepare(
      'INSERT INTO task_revisions(task_id,version,decision_id,snapshot) VALUES(?,?,?,?)',
    ).run(taskId, task.version, decisionId, JSON.stringify(task))
    db.prepare(
      'INSERT INTO notification_outbox(decision_id,created_at,payload) VALUES(?,?,?)',
    ).run(
      decisionId,
      new Date().toISOString(),
      JSON.stringify({ taskId: task.id, version: task.version, scope }),
    )
    sync(task)
    return task
  }
  function bump(taskId: string) {
    db.prepare(
      'UPDATE tasks SET version=version+1,manual_version=manual_version+1 WHERE id=?',
    ).run(taskId)
  }
  return {
    listProjects() {
      return db.prepare('SELECT id,name FROM projects ORDER BY id').all() as {
        id: string
        name: string
      }[]
    },
    createProject(id: string, name: string) {
      text(id)
      text(name, 512)
      db.prepare('INSERT INTO projects(id,name) VALUES(?,?)').run(id, name)
    },
    assignEvent(projectId: string, eventId: number) {
      text(projectId)
      integer(eventId)
      db.prepare(
        'INSERT INTO event_projects(project_id,event_id) VALUES(?,?) ON CONFLICT DO NOTHING',
      ).run(projectId, eventId)
    },
    create: db.transaction(
      (
        input: {
          id: string
          projectId: string
          title: string
          owner?: string
          admission?: StoredAdmission
          dueAt?: string | null
        },
        by: ManualActor,
      ) => {
        actor(by)
        text(input.id)
        text(input.projectId)
        text(input.title, 512)
        if (input.owner !== undefined) text(input.owner)
        if (input.admission !== undefined)
          choice(input.admission, ['candidate', 'accepted', 'ignored'])
        db.prepare(
          `INSERT INTO tasks(id,project_id,title,owner,status,evidence_status,manual_version,admission,due_at) VALUES(?,?,?,?,'todo','unknown',1,?,?)`,
        ).run(
          input.id,
          input.projectId,
          input.title,
          input.owner ?? null,
          input.admission ?? 'candidate',
          input.dueAt === undefined ? null : dueDate(input.dueAt),
        )
        return record(input.id, by, 'create', { title: input.title })
      },
    ),
    get(projectId: string, taskId: string) {
      text(projectId)
      text(taskId)
      const task = read(taskId)
      return task?.projectId === projectId ? task : undefined
    },
    listPage: db.transaction((input: TaskPageQuery = {}): TaskPage => {
      const limit = input.limit ?? 50
      integer(limit)
      if (limit > 100) throw new Error('INVALID_TASK_INPUT')
      const archive = input.archive ?? 'active'
      choice(archive, ['active', 'archived', 'all'])
      const where: string[] = []
      const params: (string | number)[] = []
      if (input.projectId === null) where.push('project_id IS NULL')
      else if (input.projectId !== undefined) {
        text(input.projectId)
        where.push('project_id=?')
        params.push(input.projectId)
      }
      if (input.status !== undefined) {
        choice(input.status, [
          'todo',
          'in_progress',
          'waiting',
          'completed',
          'cancelled',
        ])
        where.push('status=?')
        params.push(input.status)
      }
      if (input.admission !== undefined) {
        choice(input.admission, ['candidate', 'accepted', 'ignored'])
        where.push('admission=?')
        params.push(input.admission)
      }
      if (archive !== 'all')
        where.push(
          archive === 'active'
            ? 'archived_at IS NULL'
            : 'archived_at IS NOT NULL',
        )
      if (input.query !== undefined) {
        const match = searchMatchExpression(input.query)
        if (input.query.trim()) {
          if (match === null) where.push('0')
          else {
            where.push(
              'tasks.rowid IN (SELECT rowid FROM task_listing_fts WHERE task_listing_fts MATCH ?)',
            )
            params.push(match)
          }
        }
      }
      const filter = JSON.stringify([
        input.projectId === undefined ? { all: true } : input.projectId,
        input.status ?? null,
        input.admission ?? null,
        archive,
        input.query ?? '',
      ])
      let after: string | undefined
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 4096)
            throw new Error()
          const bytes = Buffer.from(input.cursor, 'base64url')
          if (bytes.toString('base64url') !== input.cursor) throw new Error()
          const value = JSON.parse(bytes.toString('utf8')) as {
            after: unknown
            filter: unknown
          }
          text(value.after)
          if (value.filter !== filter) throw new Error()
          after = value.after
        } catch {
          throw new Error('INVALID_TASK_CURSOR')
        }
      }
      const condition = where.length ? where.join(' AND ') : '1'
      const totalCount = (
        db
          .prepare(`SELECT count(*) AS count FROM tasks WHERE ${condition}`)
          .get(...params) as { count: number }
      ).count
      const activeCount = (
        db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE archived_at IS NULL AND status NOT IN ('completed','cancelled') AND admission!='ignored'",
          )
          .get() as { count: number }
      ).count
      if (after !== undefined) {
        where.push('id COLLATE BINARY > ?')
        params.push(after)
      }
      const items = db
        .prepare(
          `${selectTask} WHERE ${where.length ? where.join(' AND ') : '1'} ORDER BY id COLLATE BINARY LIMIT ?`,
        )
        .all(...params, limit + 1) as StoredTask[]
      const more = items.length > limit
      if (more) items.pop()
      return {
        items,
        totalCount,
        activeCount,
        nextCursor: more
          ? Buffer.from(
              JSON.stringify({ after: items.at(-1)!.id, filter }),
            ).toString('base64url')
          : null,
      }
    }),
    getCriteria(
      projectId: string,
      taskId: string,
      version?: number,
    ): { version: number; items: CriterionInput[] } {
      text(projectId)
      text(taskId)
      const task = read(taskId)
      if (!task || task.projectId !== projectId)
        throw new Error('TASK_NOT_IN_PROJECT')
      const selected = version ?? task.criteriaVersion
      integer(selected, 0)
      if (selected > task.criteriaVersion)
        throw new Error('UNKNOWN_CRITERIA_VERSION')
      const items = db
        .prepare(
          'SELECT criterion_id AS id,description,origin_event_id AS originEventId FROM criteria WHERE task_id=? AND version=? ORDER BY criterion_id',
        )
        .all(taskId, selected) as {
        id: string
        description: string
        originEventId: number | null
      }[]
      return {
        version: selected,
        items: items.map(({ originEventId, ...item }) =>
          originEventId === null ? item : { ...item, originEventId },
        ),
      }
    },
    getDecisionHistory(
      projectId: string,
      taskId: string,
      limit = 100,
    ): TaskDecisionSummary[] {
      text(projectId)
      text(taskId)
      integer(limit)
      if (limit > 100) throw new Error('INVALID_TASK_INPUT')
      if (read(taskId)?.projectId !== projectId)
        throw new Error('TASK_NOT_IN_PROJECT')
      return db
        .prepare(
          'SELECT id,scope,actor_id AS actorId,reason,created_at AS createdAt,task_version AS taskVersion,criteria_version AS criteriaVersion FROM decisions WHERE task_id=? ORDER BY id DESC LIMIT ?',
        )
        .all(taskId, limit) as TaskDecisionSummary[]
    },
    list(projectId: string, limit = 100) {
      text(projectId)
      integer(limit)
      if (limit > 100) throw new Error('INVALID_TASK_INPUT')
      return db
        .prepare(`${selectTask} WHERE project_id=? ORDER BY id LIMIT ?`)
        .all(projectId, limit) as StoredTask[]
    },
    listUnassigned(limit = 100) {
      integer(limit)
      if (limit > 100) throw new Error('INVALID_TASK_INPUT')
      return db
        .prepare(`${selectTask} WHERE project_id IS NULL ORDER BY id LIMIT ?`)
        .all(limit) as StoredTask[]
    },
    assignLegacy: db.transaction(
      (
        taskId: string,
        projectId: string,
        expectedVersion: number,
        by: ManualActor,
      ) => {
        text(taskId)
        text(projectId)
        integer(expectedVersion)
        actor(by)
        const task = read(taskId)
        if (!task || task.projectId !== null)
          throw new Error('TASK_NOT_UNASSIGNED')
        if (task.version !== expectedVersion)
          throw new Error('VERSION_CONFLICT')
        // Preserve original legacy snapshot before its first audited assignment.
        db.prepare(
          'INSERT OR IGNORE INTO task_revisions(task_id,version,snapshot) VALUES(?,?,?)',
        ).run(taskId, task.version, JSON.stringify(task))
        db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(
          projectId,
          taskId,
        )
        bump(taskId)
        return record(taskId, by, 'project', { projectId })
      },
    ),
    update: db.transaction(
      (input: TaskExpectation, patch: TaskPatch, by: ManualActor) => {
        actor(by)
        const task = requireTask(input)
        const keys = Object.keys(patch)
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
          throw new Error('INVALID_TASK_INPUT')
        if (patch.title !== undefined) text(patch.title, 512)
        if (patch.owner !== undefined && patch.owner !== null) text(patch.owner)
        if (patch.status !== undefined)
          choice(patch.status, [
            'todo',
            'in_progress',
            'waiting',
            'completed',
            'cancelled',
          ])
        if (patch.admission !== undefined)
          choice(patch.admission, ['candidate', 'accepted', 'ignored'])
        if (patch.archived !== undefined && typeof patch.archived !== 'boolean')
          throw new Error('INVALID_TASK_INPUT')
        db.prepare(
          'UPDATE tasks SET title=?,owner=?,status=?,admission=?,archived_at=?,due_at=? WHERE id=?',
        ).run(
          patch.title ?? task.title,
          patch.owner === undefined ? task.owner : patch.owner,
          patch.status ?? task.status,
          patch.admission ?? task.admission,
          patch.archived === undefined
            ? task.archivedAt
            : patch.archived
              ? new Date().toISOString()
              : null,
          patch.dueAt === undefined ? task.dueAt : dueDate(patch.dueAt),
          task.id,
        )
        bump(task.id)
        // One decision/revision describes the atomic patch; field-scoped pointers preserve active manual overrides.
        const result = record(task.id, by, keys.sort().join(','), patch)
        const decision = db
          .prepare(
            'SELECT decision_id FROM task_revisions WHERE task_id=? AND version=?',
          )
          .get(task.id, result.version) as { decision_id: number }
        for (const key of keys)
          db.prepare(
            'INSERT INTO manual_overrides(task_id,scope,decision_id) VALUES(?,?,?) ON CONFLICT(task_id,scope) DO UPDATE SET decision_id=excluded.decision_id',
          ).run(task.id, key, decision.decision_id)
        return result
      },
    ),
    replaceCriteria: db.transaction(
      (input: TaskExpectation, criteria: CriterionInput[], by: ManualActor) => {
        actor(by)
        const task = requireTask(input)
        if (!Array.isArray(criteria) || criteria.length > 32)
          throw new Error('INVALID_TASK_INPUT')
        const ids = new Set<string>()
        let length = 0
        for (const item of criteria) {
          text(item.id)
          text(item.description, 512)
          length += item.description.length
          if (ids.has(item.id)) throw new Error('DUPLICATE_CRITERION')
          ids.add(item.id)
          if (item.originEventId !== undefined)
            eventInProject(input.projectId, item.originEventId)
        }
        if (length + criteria.length > 16384)
          throw new Error('INVALID_TASK_INPUT')
        const version = task.criteriaVersion + 1
        db.prepare(
          'INSERT INTO criterion_sets(task_id,version) VALUES(?,?)',
        ).run(task.id, version)
        for (const item of criteria)
          db.prepare(
            'INSERT INTO criteria(task_id,project_id,version,criterion_id,description,origin_event_id) VALUES(?,?,?,?,?,?)',
          ).run(
            task.id,
            input.projectId,
            version,
            item.id,
            item.description,
            item.originEventId ?? null,
          )
        db.prepare(
          "UPDATE tasks SET criteria_version=?,evidence_status='unknown' WHERE id=?",
        ).run(version, task.id)
        bump(task.id)
        return record(
          task.id,
          by,
          'criteria',
          criteria,
          criteria.flatMap((c) =>
            c.originEventId === undefined ? [] : [c.originEventId],
          ),
        )
      },
    ),
    addEvidence: db.transaction(
      (input: TaskExpectation, evidence: EvidenceInput, by: ManualActor) => {
        actor(by)
        const task = requireTask(input)
        text(evidence.id)
        text(evidence.criterionId)
        text(evidence.reason, 2048)
        integer(evidence.criteriaVersion)
        if (evidence.criteriaVersion !== task.criteriaVersion)
          throw new Error('STALE_CRITERIA')
        choice(evidence.relation, ['supports', 'opposes', 'related'])
        choice(evidence.validity, ['unknown', 'valid', 'invalid'])
        eventInProject(input.projectId, evidence.eventId)
        if (createRetractions(db).forEvent(input.projectId, evidence.eventId))
          throw new Error('EVENT_RETRACTED')
        db.prepare(
          'INSERT INTO evidence_links(id,task_id,project_id,criterion_version,criterion_id,event_id,relation,validity,reason) VALUES(?,?,?,?,?,?,?,?,?)',
        ).run(
          evidence.id,
          task.id,
          input.projectId,
          evidence.criteriaVersion,
          evidence.criterionId,
          evidence.eventId,
          evidence.relation,
          evidence.validity,
          evidence.reason,
        )
        createRevisionReview(db).observe(input.projectId, evidence.eventId)
        bump(task.id)
        return record(task.id, by, `evidence:${evidence.id}`, evidence, [
          evidence.eventId,
        ])
      },
    ),
    history(projectId: string, taskId: string) {
      text(projectId)
      text(taskId)
      if (read(taskId)?.projectId !== projectId)
        throw new Error('TASK_NOT_IN_PROJECT')
      return {
        revisions: db
          .prepare(
            'SELECT version,snapshot,decision_id AS decisionId FROM task_revisions WHERE task_id=? ORDER BY version',
          )
          .all(taskId),
        decisions: db
          .prepare('SELECT * FROM decisions WHERE task_id=? ORDER BY id')
          .all(taskId),
        criteria: db
          .prepare(
            'SELECT * FROM criteria WHERE task_id=? ORDER BY version,criterion_id',
          )
          .all(taskId),
        evidence: db
          .prepare('SELECT * FROM evidence_links WHERE task_id=? ORDER BY id')
          .all(taskId),
        overrides: db
          .prepare(
            'SELECT scope,decision_id AS decisionId FROM manual_overrides WHERE task_id=? ORDER BY scope',
          )
          .all(taskId),
      }
    },
    rebuildSearch: db.transaction(() => {
      db.prepare('DELETE FROM task_listing_fts').run()
      // Clear projections only for authoritative task IDs; retain unrelated explicit projection clients.
      db.prepare(
        'DELETE FROM candidate_search_fts WHERE rowid IN (SELECT d.id FROM candidate_search_documents d JOIN tasks t ON t.id=d.candidate_id)',
      ).run()
      db.prepare(
        'DELETE FROM candidate_search_documents WHERE candidate_id IN (SELECT id FROM tasks)',
      ).run()
      let lastId = ''
      while (true) {
        const batch = db
          .prepare(`${selectTask} WHERE id>? ORDER BY id LIMIT 100`)
          .all(lastId) as StoredTask[]
        if (!batch.length) break
        for (const task of batch) {
          sync(task)
          lastId = task.id
        }
      }
    }),
  }
}

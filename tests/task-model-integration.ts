import { openStore, type StoredTask, type TaskExpectation } from '@memo/storage'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const folder = mkdtempSync(join(tmpdir(), 'bugu-task-model-'))
const path = join(folder, 'model.sqlite')
const by = { actorId: 'synthetic-user', reason: '用户明确修改' }
const expected = (task: StoredTask): TaskExpectation => ({
  projectId: task.projectId!,
  taskId: task.id,
  expectedVersion: task.version,
  expectedCriteriaVersion: task.criteriaVersion,
  expectedManualVersion: task.manualVersion,
})
try {
  let store = openStore(path)
  store.registerSource('fixture')
  for (let i = 1; i <= 2; i++)
    store.receive(
      {
        schemaVersion: 1,
        sourceInstanceId: 'fixture',
        externalId: `e${i}`,
        revision: '1',
        occurredAt: '2026-09-13T00:00:00Z',
        role: 'user',
        text: `虚构约定 ${i}`,
      },
      'cursor',
    )
  store.search.upsert({
    projectId: 'unverified-project',
    candidateId: 'legacy',
    title: '旧任务',
    text: '',
    codeIdentifiers: [],
  })
  store.close()
  // Restore the exact v2 task columns while retaining existing events, jobs and search projections.
  const legacy = new Database(path)
  legacy.exec(`DROP TABLE plugin_source_history; DROP TABLE plugin_bindings; DROP TABLE source_grants;DROP TABLE task_listing_fts;DROP TABLE notification_outbox;DROP TABLE manual_overrides;DROP TABLE task_revisions;DROP TABLE decisions;DROP TABLE evidence_links;DROP TABLE criteria;DROP TABLE criterion_sets;DROP TABLE event_projects;
    DROP TABLE tasks;DROP TABLE projects;
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('todo','in_progress','waiting','completed','cancelled')),
      evidence_status TEXT NOT NULL CHECK(evidence_status IN ('unknown','partial','sufficient','conflict')),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),archived_at TEXT);
    INSERT INTO tasks(id,title,status,evidence_status,version,archived_at) VALUES('legacy','旧任务','waiting','partial',4,'2026-09-12T00:00:00Z');PRAGMA user_version=2;`)
  legacy.close()
  store = openStore(path)
  const tasks = store.tasks
  assert.equal(store.health().schemaVersion, 6)
  assert.equal(store.health().eventCount, 2)
  assert.equal(store.health().jobCount, 2)
  assert.equal(store.cursor('fixture'), 'cursor')
  assert.deepEqual(tasks.listProjects(), [])
  assert.deepEqual(
    store.search.query({ projectId: 'unverified-project', text: '旧任务' }),
    [],
  )
  const old = tasks.listUnassigned()[0]!
  assert.equal(old.projectId, null)
  assert.equal(old.version, 4)
  assert.equal(old.status, 'waiting')
  assert.equal(old.evidenceStatus, 'partial')
  assert.ok(old.archivedAt)
  tasks.createProject('alpha', '测试项目甲')
  tasks.createProject('beta', '测试项目乙')
  assert.deepEqual(
    store.search.query({ projectId: 'alpha', text: '旧任务' }),
    [],
  )
  const assigned = tasks.assignLegacy('legacy', 'alpha', 4, by)
  assert.equal(assigned.status, 'waiting')
  assert.equal(assigned.version, 5)
  assert.equal(assigned.evidenceStatus, 'partial')
  assert.ok(assigned.archivedAt)
  assert.equal(tasks.listUnassigned().length, 0)
  assert.throws(
    () =>
      tasks.create(
        { id: 'bad', projectId: 'missing', title: '不存在项目' },
        by,
      ),
    /FOREIGN KEY/,
  )
  tasks.assignEvent('alpha', 1)
  tasks.assignEvent('beta', 2)
  let task = tasks.create(
    { id: 't1', projectId: 'alpha', title: '修复登录BUGU' },
    by,
  )
  assert.equal(task.admission, 'candidate')
  assert.equal(task.status, 'todo')
  assert.equal(
    store.search.query({ projectId: 'alpha', text: '登录' })[0]?.candidateId,
    't1',
  )
  assert.equal(tasks.get('beta', 't1'), undefined)
  assert.throws(
    () =>
      tasks.update(
        { ...expected(task), projectId: 'beta' },
        { title: '越界' },
        by,
      ),
    /TASK_NOT_IN_PROJECT/,
  )
  assert.throws(
    () =>
      tasks.update(
        { ...expected(task), expectedManualVersion: 1 + task.manualVersion },
        { title: '过时' },
        by,
      ),
    /VERSION_CONFLICT/,
  )
  assert.throws(
    () =>
      tasks.replaceCriteria(
        expected(task),
        [{ id: 'c1', description: '越界条件', originEventId: 2 }],
        by,
      ),
    /EVENT_NOT_IN_PROJECT/,
  )
  task = tasks.replaceCriteria(
    expected(task),
    [{ id: 'c1', description: '提交可复核结果', originEventId: 1 }],
    by,
  )
  assert.equal(task.criteriaVersion, 1)
  assert.equal(
    store.search.query({ projectId: 'alpha', text: '复核' })[0]?.candidateId,
    't1',
  )
  const evidence = {
    id: 'ev1',
    criterionId: 'c1',
    criteriaVersion: 1,
    eventId: 1,
    relation: 'supports' as const,
    validity: 'valid' as const,
    reason: '手工核验原始记录',
  }
  assert.throws(
    () => tasks.addEvidence(expected(task), { ...evidence, eventId: 2 }, by),
    /EVENT_NOT_IN_PROJECT/,
  )
  assert.throws(
    () =>
      tasks.addEvidence(
        expected(task),
        { ...evidence, criterionId: 'missing' },
        by,
      ),
    /FOREIGN KEY/,
  )
  task = tasks.addEvidence(expected(task), evidence, by)
  assert.equal(task.status, 'todo')
  assert.equal(task.evidenceStatus, 'unknown')
  task = tasks.replaceCriteria(
    expected(task),
    [{ id: 'c1', description: '发布并反馈结果', originEventId: 1 }],
    by,
  )
  assert.equal(task.criteriaVersion, 2)
  assert.throws(
    () => tasks.addEvidence(expected(task), { ...evidence, id: 'ev2' }, by),
    /STALE_CRITERIA/,
  )
  assert.deepEqual(store.search.query({ projectId: 'alpha', text: '复核' }), [])
  assert.equal(
    store.search.query({ projectId: 'alpha', text: '反馈' })[0]?.candidateId,
    't1',
  )
  assert.equal(tasks.history('alpha', 't1').criteria.length, 2)
  assert.equal(tasks.history('alpha', 't1').evidence.length, 1)
  task = tasks.update(expected(task), { status: 'completed' }, by)
  task = tasks.update(expected(task), { archived: true }, by)
  assert.equal(task.status, 'completed')
  assert.equal(task.evidenceStatus, 'unknown')
  assert.deepEqual(store.search.query({ projectId: 'alpha', text: '登录' }), [])
  task = tasks.update(expected(task), { archived: false }, by)
  assert.equal(task.status, 'completed')
  task = tasks.update(expected(task), { admission: 'ignored' }, by)
  assert.equal(task.status, 'completed')
  assert.deepEqual(store.search.query({ projectId: 'alpha', text: '登录' }), [])
  task = tasks.update(expected(task), { admission: 'accepted' }, by)
  assert.equal(
    store.search.query({ projectId: 'alpha', text: '登录' }).length,
    1,
  )
  const raw = new Database(path)
  raw.pragma('foreign_keys=ON')
  assert.equal(
    (
      raw
        .prepare('SELECT count(*) AS n FROM pragma_foreign_key_check')
        .get() as { n: number }
    ).n,
    0,
  )
  assert.throws(
    () =>
      raw
        .prepare(
          "INSERT INTO evidence_links VALUES('illegal','t1','beta',2,'c1',2,'supports','valid','x')",
        )
        .run(),
    /FOREIGN KEY/,
  )
  assert.throws(
    () =>
      raw
        .prepare(
          "INSERT INTO evidence_links VALUES('illegal','t1','alpha',2,'c1',1,'garbage','valid','x')",
        )
        .run(),
    /CHECK/,
  )
  assert.throws(
    () => raw.prepare('DELETE FROM source_events WHERE id=1').run(),
    /FOREIGN KEY/,
  )
  const before = tasks.history('alpha', 't1')
  const pendingBefore = (
    raw.prepare('SELECT count(*) AS n FROM notification_outbox').get() as {
      n: number
    }
  ).n
  raw.exec(
    "CREATE TRIGGER fail_projection BEFORE UPDATE ON candidate_search_documents BEGIN SELECT RAISE(ABORT,'SIMULATED_INDEX_FAILURE'); END",
  )
  assert.throws(
    () => tasks.update(expected(task), { title: '不能半写入' }, by),
    /SIMULATED_INDEX_FAILURE/,
  )
  assert.deepEqual(tasks.get('alpha', 't1'), task)
  assert.deepEqual(tasks.history('alpha', 't1'), before)
  assert.equal(
    (
      raw.prepare('SELECT count(*) AS n FROM notification_outbox').get() as {
        n: number
      }
    ).n,
    pendingBefore,
  )
  raw.exec('DROP TRIGGER fail_projection')
  const stale = expected(task)
  task = tasks.update(stale, { title: '新标题' }, by)
  assert.throws(
    () => tasks.update(stale, { title: '覆盖' }, by),
    /VERSION_CONFLICT/,
  )
  const manual = raw
    .prepare(
      "SELECT d.actor,d.scope FROM manual_overrides o JOIN decisions d ON d.id=o.decision_id WHERE o.task_id='t1' AND o.scope='status'",
    )
    .get() as { actor: string; scope: string }
  assert.equal(manual.actor, 'manual')
  assert.equal(manual.scope, 'status')
  assert.equal(
    (
      raw
        .prepare('SELECT count(*) AS n FROM notification_outbox WHERE state=?')
        .get('pending') as { n: number }
    ).n,
    pendingBefore + 1,
  )
  raw.prepare('DELETE FROM candidate_search_fts').run()
  tasks.rebuildSearch()
  assert.equal(
    store.search.query({ projectId: 'alpha', text: '新标题' })[0]?.candidateId,
    't1',
  )
  assert.equal(
    store.search.query({ projectId: 'beta', text: '新标题' }).length,
    0,
  )
  assert.throws(
    () =>
      raw
        .prepare(
          "UPDATE tasks SET due_at='2026-02-30T00:00:00.000Z' WHERE id='t1'",
        )
        .run(),
    /CHECK/,
  )
  assert.equal(task.dueAt, null)
  for (const dueAt of [
    '2026-02-30T09:00:00Z',
    '2026-09-13',
    '2026-09-13T24:00:00Z',
    '2026-09-13T10:00:00+08:00',
    'invalid',
  ]) {
    assert.throws(
      () => tasks.update(expected(task), { dueAt }, by),
      /INVALID_DUE_DATE/,
    )
    assert.deepEqual(tasks.get('alpha', 't1'), task)
  }
  task = tasks.update(expected(task), { dueAt: '2026-09-15T09:00:00.1Z' }, by)
  assert.equal(task.dueAt, '2026-09-15T09:00:00.100Z')
  assert.equal(tasks.getDecisionHistory('alpha', 't1')[0]?.scope, 'dueAt')
  const historical = tasks.getCriteria('alpha', 't1', 1)
  assert.equal(historical.version, 1)
  assert.equal(historical.items[0]?.description, '提交可复核结果')
  assert.equal(tasks.getCriteria('alpha', 't1').version, 2)
  assert.throws(() => tasks.getCriteria('beta', 't1'), /TASK_NOT_IN_PROJECT/)
  assert.throws(
    () => tasks.getCriteria('alpha', 't1', 3),
    /UNKNOWN_CRITERIA_VERSION/,
  )
  task = tasks.update(expected(task), { dueAt: null }, by)
  assert.equal(task.dueAt, null)
  // Query filters precede keyset/LIMIT; archive and ignored queries use their own all-task FTS.
  for (let n = 0; n < 105; n++)
    tasks.create(
      {
        id: `p${String(n).padStart(3, '0')}`,
        projectId: 'beta',
        title: '分页测试',
        admission: 'accepted',
      },
      by,
    )
  let hidden = tasks.create(
    { id: 'a-hidden', projectId: 'alpha', title: '归档可搜' },
    by,
  )
  hidden = tasks.update(
    expected(hidden),
    { archived: true, admission: 'ignored' },
    by,
  )
  assert.deepEqual(
    tasks.listPage({ query: '归档', archive: 'all' }).items.map((t) => t.id),
    ['a-hidden'],
  )
  assert.equal(tasks.listPage({ query: '归档' }).totalCount, 0)
  const first = tasks.listPage({
    projectId: 'beta',
    query: '分页',
    status: 'todo',
    admission: 'accepted',
    limit: 60,
  })
  assert.equal(first.items.length, 60)
  assert.equal(first.totalCount, 105)
  assert.ok(first.nextCursor)
  // Delete a previous row between pages: keyset must not skip the next row as offset does.
  raw
    .prepare(
      "UPDATE tasks SET archived_at='2026-09-13T00:00:00Z' WHERE id='p000'",
    )
    .run()
  const second = tasks.listPage({
    projectId: 'beta',
    query: '分页',
    status: 'todo',
    admission: 'accepted',
    limit: 60,
    cursor: first.nextCursor!,
  })
  assert.equal(second.items.length, 45)
  assert.equal(second.items[0]?.id, 'p060')
  assert.equal(second.nextCursor, null)
  assert.equal(second.totalCount, 104)
  assert.equal(
    new Set([...first.items, ...second.items].map((t) => t.id)).size,
    105,
  )
  assert.throws(
    () => tasks.listPage({ projectId: 'alpha', cursor: first.nextCursor! }),
    /INVALID_TASK_CURSOR/,
  )
  assert.throws(
    () => tasks.listPage({ cursor: 'invalid' }),
    /INVALID_TASK_CURSOR/,
  )
  assert.throws(() => tasks.listPage({ limit: 101 }), /INVALID_TASK_INPUT/)
  assert.throws(
    () => tasks.listPage({ query: 'x'.repeat(257) }),
    /INVALID_SEARCH_INPUT/,
  )
  assert.equal(tasks.listPage({ projectId: "beta' OR 1=1 --" }).items.length, 0)
  assert.equal(tasks.listPage({ query: '" : * ()' }).items.length, 0)
  assert.equal(tasks.listPage({ projectId: 'beta', limit: 1 }).activeCount, 104)
  assert.equal(
    tasks.listPage({ projectId: 'beta', query: '分页', limit: 1 }).items.length,
    1,
  )
  raw.close()
  store.close()
  store = openStore(path)
  assert.deepEqual(store.tasks.get('alpha', 't1'), task)
  assert.equal(
    store.tasks.history('alpha', 't1').revisions.length,
    task.version,
  )
  store.close()
  // Independently exercise v3 -> v4 with existing manual history and searchable criteria.
  const v3 = new Database(path)
  v3.exec(
    'DROP TABLE plugin_source_history; DROP TABLE plugin_bindings; DROP TABLE source_grants; DROP TABLE task_listing_fts; ALTER TABLE tasks DROP COLUMN due_at; PRAGMA user_version=3;',
  )
  const oldDecisions = (
    v3.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }
  ).n
  v3.close()
  store = openStore(path)
  assert.equal(store.health().schemaVersion, 6)
  assert.equal(store.tasks.get('alpha', 't1')?.dueAt, null)
  assert.equal(store.tasks.getCriteria('alpha', 't1').version, 2)
  assert.equal(store.tasks.listPage({ query: '新标题' }).items[0]?.id, 't1')
  const migrated = new Database(path)
  assert.equal(
    (
      migrated.prepare('SELECT count(*) AS n FROM decisions').get() as {
        n: number
      }
    ).n,
    oldDecisions,
  )
  migrated.close()
  store.close()
  console.log(
    'Task model integration passed: v2 migration, project isolation, criteria history, evidence FKs, manual audit, archive, optimistic concurrency, outbox and search atomicity',
  )
} finally {
  rmSync(folder, { recursive: true, force: true })
}

import { prepareEventProcessing } from '@memo/application'
import { openStore, type StoredTask, type TaskExpectation } from '@memo/storage'
import Database from 'better-sqlite3'
import { createExports, EXPORT_MAX_BYTES } from '../packages/storage/src/export'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const folder = mkdtempSync(join(tmpdir(), 'bugu-export-'))
const path = join(folder, 'test.sqlite')
const by = { actorId: 'synthetic-user', reason: '明确人工操作' }
const expected = (t: StoredTask): TaskExpectation => ({
  projectId: t.projectId!,
  taskId: t.id,
  expectedVersion: t.version,
  expectedCriteriaVersion: t.criteriaVersion,
  expectedManualVersion: t.manualVersion,
})
try {
  {
    const rulePath = join(folder, 'rule.sqlite')
    const rules = openStore(rulePath)
    rules.tasks.createProject('rules', '规则候选项目')
    rules.tasks.createProject('other', '隔离项目')
    const grant = rules.sources.authorize({
      projectId: 'rules',
      path: join(folder, 'PRIVATE_RULE_PATH.jsonl'),
    })
    let cursor = ''
    const now = new Date('2026-09-13T12:00:00Z')
    const ingest = (externalId: string, revision: string, text: string) => {
      const next = cursor + 'x'
      rules.sources.receiveBatch(
        grant.id,
        grant.grantVersion,
        [
          {
            schemaVersion: 1,
            sourceInstanceId: grant.id,
            externalId,
            revision,
            text,
            role: 'user',
            occurredAt: '2026-09-13T09:00:00Z',
          },
        ],
        next,
        cursor,
      )
      cursor = next
      const job = rules.processing.claim(now)!
      const context = rules.processing.load(job, now)!
      return rules.processing.commit(
        job,
        context,
        prepareEventProcessing({
          event: context.event,
          eventId: context.eventId,
          projectId: context.projectId,
        }),
        now,
      )
    }
    const taskId = ingest('one', '1', '我会提交规则候选报告。').taskIds[0]!
    ingest('one', '2', '取消原计划 PRIVATE_REVIEW_BODY')
    const unrelated = ingest('two', '1', '我会提交另一份报告。').taskIds[0]!
    const ruleScope = {
      projectId: 'rules',
      taskIds: [taskId],
      includeSourceText: true,
    }
    const full = rules.exports.build(ruleScope)
    assert.equal(full.schemaVersion, 2)
    assert.equal(full.decisions.length, 0)
    assert.equal(full.ruleDecisions.length, 2)
    assert.deepEqual(
      full.ruleDecisions.map((d) => d.actor),
      ['rule', 'rule'],
    )
    assert.deepEqual(
      full.ruleDecisions.map((d) => d.outcome),
      ['created', 'review_required'],
    )
    assert.equal(full.candidateEvidence.length, 1)
    assert.equal(full.candidateEvidence[0]!.quote, '我会提交规则候选报告。')
    assert.equal(full.events.length, 2)
    assert.equal(full.events[1]!.text, '取消原计划 PRIVATE_REVIEW_BODY')
    assert.equal(full.tasks[0]!.manualVersion, 0)
    assert.equal(full.revisions[0]!.decisionId, null)
    assert.ok(!full.tasks.some((t) => t.id === unrelated))
    const redacted = rules.exports.build({
      ...ruleScope,
      includeSourceText: false,
    })
    assert.ok(redacted.events.every((e) => !('text' in e)))
    assert.ok(redacted.candidateEvidence.every((e) => !('quote' in e)))
    const serialized = JSON.stringify(redacted)
    assert.ok(!serialized.includes('我会'))
    assert.ok(!serialized.includes('PRIVATE_REVIEW_BODY'))
    assert.ok(!serialized.includes('PRIVATE_RULE_PATH'))
    assert.equal(redacted.ruleDecisions.length, 2)
    assert.equal(redacted.events.length, 2)
    assert.throws(
      () => rules.exports.build({ ...ruleScope, projectId: 'other' }),
      /EXPORT_TASK_NOT_IN_PROJECT/,
    )
    rules.sources.revoke(grant.id)
    assert.ok(
      rules.exports
        .build(ruleScope)
        .events.every((e) => e.sourceStatus === 'revoked'),
    )
    const ruleRaw = new Database(rulePath)
    ruleRaw
      .prepare('UPDATE processing_evidence SET quote=? WHERE task_id=?')
      .run('TAMPERED_QUOTE', taskId)
    assert.throws(
      () => rules.exports.build({ ...ruleScope, includeSourceText: false }),
      /EXPORT_CORRUPT_DATA/,
    )
    ruleRaw
      .prepare('UPDATE processing_evidence SET quote=? WHERE task_id=?')
      .run('我会提交规则候选报告。', taskId)
    const savedEvidence = ruleRaw
      .prepare('SELECT * FROM processing_evidence WHERE task_id=?')
      .get(taskId) as Record<string, string | number>
    ruleRaw
      .prepare('DELETE FROM processing_evidence WHERE task_id=?')
      .run(taskId)
    assert.throws(() => rules.exports.build(ruleScope), /EXPORT_CORRUPT_DATA/)
    ruleRaw
      .prepare(
        'INSERT INTO processing_evidence(id,project_id,task_id,event_id,quote_start,quote_end,quote) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        savedEvidence.id!,
        savedEvidence.project_id!,
        savedEvidence.task_id!,
        savedEvidence.event_id!,
        savedEvidence.quote_start!,
        savedEvidence.quote_end!,
        savedEvidence.quote!,
      )
    ruleRaw
      .prepare('UPDATE processing_decisions SET reason=? WHERE task_id=?')
      .run('/PRIVATE_ERROR', taskId)
    assert.throws(() => rules.exports.build(ruleScope), /EXPORT_CORRUPT_DATA/)
    ruleRaw.close()
    rules.close()
  }
  const store = openStore(path)
  store.tasks.createProject('p', '导出项目')
  store.tasks.createProject('other', '无关项目')
  const source = store.sources.authorize({
    path: join(folder, 'private-path.jsonl'),
    projectId: 'p',
  })
  const event = {
    schemaVersion: 1 as const,
    sourceInstanceId: source.id,
    externalId: 'x',
    revision: '1',
    occurredAt: '2026-09-13T00:00:00Z',
    role: 'tool' as const,
    text: 'PRIVATE_SOURCE_BODY',
  }
  store.sources.receiveBatch(source.id, 1, [event], 'PRIVATE_CURSOR', '')
  let task = store.tasks.create(
    { id: 't', projectId: 'p', title: '需要导出的事项' },
    by,
  )
  task = store.tasks.replaceCriteria(
    expected(task),
    [{ id: 'c', description: '原条件', originEventId: 1 }],
    by,
  )
  task = store.tasks.addEvidence(
    expected(task),
    {
      id: 'e1',
      criterionId: 'c',
      criteriaVersion: 1,
      eventId: 1,
      relation: 'opposes',
      validity: 'valid',
      reason: '有效反证',
    },
    by,
  )
  task = store.tasks.addEvidence(
    expected(task),
    {
      id: 'e2',
      criterionId: 'c',
      criteriaVersion: 1,
      eventId: 1,
      relation: 'supports',
      validity: 'invalid',
      reason: '无效证据不可支撑完成',
    },
    by,
  )
  task = store.tasks.replaceCriteria(expected(task), [], by)
  task = store.tasks.update(
    expected(task),
    { status: 'completed', archived: true },
    by,
  )
  // More than the UI history limit must still export completely.
  for (let i = 0; i < 103; i++)
    task = store.tasks.update(expected(task), { title: `修订 ${i}` }, by)
  store.tasks.create(
    { id: 'unrelated', projectId: 'other', title: 'NEVER_EXPORT_OTHER' },
    by,
  )
  store.sources.revoke(source.id)
  const scope = { projectId: 'p', includeSourceText: false }
  const exported = store.exports.build(scope)
  assert.equal(exported.schemaVersion, 2)
  assert.deepEqual(exported.selection, { mode: 'project' })
  assert.deepEqual(
    store.exports.build({ ...scope, taskIds: ['t'] }).selection,
    { mode: 'tasks', taskIds: ['t'] },
  )
  assert.equal(exported.sourceBodiesIncluded, false)
  assert.equal(exported.tasks.length, 1)
  assert.equal(exported.tasks[0]?.status, 'completed')
  assert.ok(exported.tasks[0]?.archivedAt)
  assert.equal(exported.criteriaSets.length, 2)
  assert.deepEqual(exported.criteriaSets[1]?.items, [])
  assert.equal(exported.criteriaSets[1]?.current, true)
  assert.equal(exported.evidence.length, 2)
  assert.equal(exported.evidence[0]?.relation, 'opposes')
  assert.equal(exported.evidence[0]?.validity, 'valid')
  assert.equal(exported.evidence[1]?.validity, 'invalid')
  assert.equal(exported.evidence[0]?.currentCriterion, false)
  assert.equal(exported.events.length, 1)
  assert.equal(exported.events[0]?.sourceStatus, 'revoked')
  assert.equal('text' in exported.events[0]!, false)
  assert.equal(exported.decisions.length, task.version)
  assert.equal(exported.revisions.length, task.version)
  assert.ok(exported.manualOverrides.some((o) => o.scope === 'status'))
  const json = JSON.stringify(exported)
  for (const secret of [
    'PRIVATE_SOURCE_BODY',
    'PRIVATE_CURSOR',
    'private-path.jsonl',
    'NEVER_EXPORT_OTHER',
    'source_grants',
    'notification_outbox',
  ])
    assert.equal(json.includes(secret), false)
  const full = store.exports.build({ ...scope, includeSourceText: true })
  assert.equal(full.events[0]?.text, 'PRIVATE_SOURCE_BODY')
  assert.throws(
    () => store.exports.build({ ...scope, taskIds: ['unrelated'] }),
    /EXPORT_TASK_NOT_IN_PROJECT/,
  )
  assert.throws(
    () => store.exports.build({ ...scope, taskIds: ['t', 't'] }),
    /EXPORT_INVALID_INPUT/,
  )
  assert.throws(
    () => store.exports.build({ ...scope, taskIds: [] }),
    /EXPORT_INVALID_INPUT/,
  )
  assert.throws(
    () => store.exports.build({ ...scope, projectId: 'missing' }),
    /EXPORT_UNKNOWN_PROJECT/,
  )
  const raw = new Database(path)
  const first = raw
    .prepare(
      'SELECT id,payload FROM decisions WHERE task_id=? ORDER BY id LIMIT 1',
    )
    .get('t') as { id: number; payload: string }
  raw
    .prepare('UPDATE decisions SET payload=? WHERE id=?')
    .run('{bad json', first.id)
  assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
  raw
    .prepare('UPDATE decisions SET payload=? WHERE id=?')
    .run(JSON.stringify({ title: 'x', path: 'PRIVATE_PATH' }), first.id)
  assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
  raw
    .prepare('UPDATE decisions SET payload=? WHERE id=?')
    .run(first.payload, first.id)
  raw.pragma('foreign_keys = OFF')
  raw
    .prepare('DELETE FROM event_projects WHERE project_id=? AND event_id=?')
    .run('p', 1)
  assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
  raw.prepare('INSERT INTO event_projects VALUES(?,?)').run('p', 1)
  raw.pragma('foreign_keys = ON')
  // Old snapshots legitimately lacked dueAt: do not synthesize history from the current task.
  const revision = raw
    .prepare(
      'SELECT version,snapshot FROM task_revisions WHERE task_id=? ORDER BY version LIMIT 1',
    )
    .get('t') as { version: number; snapshot: string }
  const old = JSON.parse(revision.snapshot) as Record<string, unknown>
  delete old.dueAt
  raw
    .prepare(
      'UPDATE task_revisions SET snapshot=? WHERE task_id=? AND version=?',
    )
    .run(JSON.stringify(old), 't', revision.version)
  assert.equal(
    'dueAt' in store.exports.build(scope).revisions[0]!.snapshot,
    false,
  )
  for (const version of [2, task.version]) {
    const missing = raw
      .prepare(
        'SELECT task_id,version,decision_id,snapshot FROM task_revisions WHERE task_id=? AND version=?',
      )
      .get('t', version) as {
      task_id: string
      version: number
      decision_id: number
      snapshot: string
    }
    raw
      .prepare('DELETE FROM task_revisions WHERE task_id=? AND version=?')
      .run('t', version)
    assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
    raw
      .prepare(
        'INSERT INTO task_revisions(task_id,version,decision_id,snapshot) VALUES(?,?,?,?)',
      )
      .run(
        missing.task_id,
        missing.version,
        missing.decision_id,
        missing.snapshot,
      )
  }
  const latest = raw
    .prepare(
      'SELECT snapshot FROM task_revisions WHERE task_id=? AND version=?',
    )
    .get('t', task.version) as { snapshot: string }
  raw
    .prepare(
      'UPDATE task_revisions SET snapshot=? WHERE task_id=? AND version=?',
    )
    .run(
      JSON.stringify({
        ...JSON.parse(latest.snapshot),
        title: '伪造的最新历史',
      }),
      't',
      task.version,
    )
  assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
  raw
    .prepare(
      'UPDATE task_revisions SET snapshot=? WHERE task_id=? AND version=?',
    )
    .run(latest.snapshot, 't', task.version)
  raw
    .prepare('UPDATE tasks SET title=? WHERE id=?')
    .run('脱离历史的当前字段', 't')
  assert.throws(() => store.exports.build(scope), /EXPORT_CORRUPT_DATA/)
  raw.prepare('UPDATE tasks SET title=? WHERE id=?').run(task.title, 't')
  const missingDueAt = JSON.parse(latest.snapshot) as Record<string, unknown>
  delete missingDueAt.dueAt
  raw
    .prepare(
      'UPDATE task_revisions SET snapshot=? WHERE task_id=? AND version=?',
    )
    .run(JSON.stringify(missingDueAt), 't', task.version)
  assert.equal(
    'dueAt' in store.exports.build(scope).revisions.at(-1)!.snapshot,
    false,
  )
  raw
    .prepare(
      'UPDATE task_revisions SET snapshot=? WHERE task_id=? AND version=?',
    )
    .run(latest.snapshot, 't', task.version)
  const originalDecisions = (
    raw.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number }
  ).n
  store.exports.build(scope)
  assert.equal(
    (raw.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number })
      .n,
    originalDecisions,
  )
  raw.transaction(() => {
    const insert = raw.prepare(
      "INSERT INTO tasks(id,project_id,title,status,evidence_status)VALUES(?,'p','上限','todo','unknown')",
    )
    for (let i = 0; i < 1000; i++) insert.run(`limit${i}`)
  })()
  assert.throws(() => store.exports.build(scope), /EXPORT_LIMIT_EXCEEDED/)
  assert.equal(
    store.exports.build({ ...scope, taskIds: ['t'] }).tasks.length,
    1,
  )
  raw
    .prepare(
      "INSERT INTO tasks(id,title,status,evidence_status,version) VALUES('legacy','旧版未分配','waiting','partial',4)",
    )
    .run()
  store.tasks.assignLegacy('legacy', 'p', 4, by)
  const legacy = store.exports.build({ ...scope, taskIds: ['legacy'] })
  assert.equal(legacy.tasks[0]?.projectId, 'p')
  assert.equal(legacy.revisions[0]?.snapshot.projectId, null)
  assert.equal(legacy.revisions[0]?.version, 4)
  assert.equal(legacy.revisions[0]?.decisionId, null)
  assert.equal(legacy.revisions[1]?.snapshot.projectId, 'p')
  raw.close()
  store.close()
  {
    // A SQL view invokes a controlled callback during the export's first read.
    // The callback commits a real write on a second WAL connection, not a mocked result.
    const concurrentPath = join(folder, 'concurrent.sqlite')
    const writer = openStore(concurrentPath)
    writer.tasks.createProject('concurrent', '并发项目')
    const before = writer.tasks.create(
      { id: 'concurrent-task', projectId: 'concurrent', title: '读取前版本' },
      by,
    )
    const reader = new Database(concurrentPath)
    reader.pragma('journal_mode=WAL')
    reader.exec(
      'ALTER TABLE projects RENAME TO export_projects; CREATE VIEW projects AS SELECT id,export_write_hook(name) AS name FROM export_projects;',
    )
    let wrote = false
    reader.function('export_write_hook', (name: unknown) => {
      if (!wrote) {
        wrote = true
        writer.tasks.update(expected(before), { title: '并发新版本' }, by)
      }
      return String(name)
    })
    const snapshot = createExports(reader).build({
      projectId: 'concurrent',
      includeSourceText: false,
    })
    assert.equal(wrote, true)
    assert.equal(
      writer.tasks.get('concurrent', 'concurrent-task')?.title,
      '并发新版本',
    )
    assert.equal(snapshot.tasks[0]?.title, '读取前版本')
    assert.equal(snapshot.tasks[0]?.version, 1)
    assert.equal(snapshot.revisions.length, 1)
    assert.equal(snapshot.decisions.length, 1)
    assert.equal(snapshot.revisions[0]?.snapshot.title, '读取前版本')
    reader.close()
    writer.close()
  }
  {
    const capacityPath = join(folder, 'capacity.sqlite')
    const capacity = openStore(capacityPath)
    capacity.tasks.createProject('capacity', '容量项目')
    capacity.registerSource('capacity-source')
    let target = capacity.tasks.create(
      { id: 'capacity-task', projectId: 'capacity', title: '容量事项' },
      by,
    )
    target = capacity.tasks.replaceCriteria(
      expected(target),
      [{ id: 'c', description: '大正文引用' }],
      by,
    )
    const seed = new Database(capacityPath)
    const body = 'x'.repeat(65536)
    seed.transaction(() => {
      const insert = seed.prepare(
        "INSERT INTO source_events(source_id,external_id,revision,occurred_at,received_at,role,content) VALUES('capacity-source',?,'1','2026-09-13T00:00:00Z','2026-09-13T00:00:00Z','user',?)",
      )
      const mapping = seed.prepare(
        "INSERT INTO event_projects(project_id,event_id) VALUES('capacity',?)",
      )
      const link = seed.prepare(
        "INSERT INTO evidence_links(id,task_id,project_id,criterion_version,criterion_id,event_id,relation,validity,reason) VALUES(?,'capacity-task','capacity',1,'c',?,'related','unknown','容量样例')",
      )
      for (let i = 0; i < 260; i++) {
        const eventId = Number(insert.run(String(i), body).lastInsertRowid)
        mapping.run(eventId)
        link.run(`large-${i}`, eventId)
      }
    })()
    assert.ok(260 * Buffer.byteLength(body) > EXPORT_MAX_BYTES)
    const metadata = capacity.exports.build({
      projectId: 'capacity',
      includeSourceText: false,
    })
    assert.equal(metadata.events.length, 260)
    assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < EXPORT_MAX_BYTES)
    assert.throws(
      () =>
        capacity.exports.build({
          projectId: 'capacity',
          includeSourceText: true,
        }),
      /EXPORT_LIMIT_EXCEEDED/,
    )
    // All-task and byte limits are separate from the aggregate row budget.
    // Tiny empty historical condition sets exceed 50,000 rows well below 16 MiB.
    seed.transaction(() => {
      const set = seed.prepare(
        "INSERT INTO criterion_sets(task_id,version) VALUES('capacity-task',?)",
      )
      for (let version = 2; version <= 50001; version++) set.run(version)
    })()
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          taskId: 'capacity-task',
          version: 50001,
          current: false,
          items: [],
        }),
      ) *
        50001 <
        EXPORT_MAX_BYTES,
    )
    assert.throws(
      () =>
        capacity.exports.build({
          projectId: 'capacity',
          includeSourceText: false,
        }),
      /EXPORT_LIMIT_EXCEEDED/,
    )
    seed.close()
    capacity.close()
  }
  console.log(
    'Export integration passed: complete history, invalid/counter evidence, source privacy, revoked grants, references, corruption task/byte/row limits, concurrent WAL snapshot and assigned legacy history',
  )
} finally {
  rmSync(folder, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import {
  createSourceAssociations,
  migrateSourceAssociations,
} from '../packages/storage/src/source-associations'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-associations-')),
  path = join(dir, 'db.sqlite'),
  store = openStore(path),
  db = new Database(path)
try {
  if ((db.pragma('user_version', { simple: true }) as number) < 17)
    migrateSourceAssociations(db)
  const a = createSourceAssociations(db),
    by = { actorId: 'local-user', reason: '明确选择' }
  store.tasks.createProject('p', '项目')
  store.tasks.createProject('q', '其他项目')
  const grants = ['a', 'b', 'c'].map((n) =>
    store.sources.authorize({ projectId: 'p', path: join(dir, n + '.jsonl') }),
  )
  const other = store.sources.authorize({
    projectId: 'q',
    path: join(dir, 'q.jsonl'),
  })
  function add(
    source: string,
    externalId: string,
    subject = 'person',
    text = '真实来源记录',
    operation: 'upsert' | 'retract' = 'upsert',
  ) {
    const e: SourceEvent = {
      schemaVersion: 1,
      sourceInstanceId: source,
      externalId,
      revision: operation === 'retract' ? '2' : '1',
      role: 'user',
      operation,
      occurredAt: '2026-09-13T10:00:00Z',
      text,
      metadata: { author: { namespace: 'account-id', subjectId: subject } },
    }
    const g = store.sources.getAuthorized(source)
    store.sources.receiveBatch(
      source,
      g.grantVersion,
      [e],
      externalId + operation,
      g.cursor,
    )
    return (
      db
        .prepare(
          'SELECT id FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
        )
        .get(source, externalId, e.revision) as { id: number }
    ).id
  }
  const e1 = add(grants[0]!.id, 'a'),
    e2 = add(grants[1]!.id, 'b'),
    e3 = add(grants[2]!.id, 'c'),
    q = add(other.id, 'q')
  const task = store.tasks.create(
    { id: 'task', projectId: 'p', title: '人工事项' },
    by,
  )
  store.tasks.create({ id: 'task2', projectId: 'p', title: '同名人工事项' }, by)
  const bind = (taskId: string, eventId: number) => {
    const t = store.tasks.get('p', taskId)!
    return a.bindSourceObject(
      {
        projectId: 'p',
        taskId,
        eventId,
        expectedTaskVersion: t.version,
        expectedCriteriaVersion: t.criteriaVersion,
        expectedManualVersion: t.manualVersion,
        reason: '选择来源对象',
      },
      by.actorId,
    )
  }
  assert.throws(() => bind('task', q), /ASSOCIATION_NOT_FOUND/)
  bind('task', e1)
  bind('task', e2)
  bind('task', e3)
  assert.equal(a.primaryEventId('p', 'task'), e1)
  assert.throws(() => bind('task2', e1), /ASSOCIATION_CONFLICT/)
  const bs = a.sourceBindings({ projectId: 'p', taskId: 'task' }).bindings
  const confirm = (left: number, right: number, version = 0) =>
    a.confirmIdentityMapping(
      {
        projectId: 'p',
        taskId: 'task',
        leftEventId: left,
        rightEventId: right,
        expectedLeftBindingVersion: 1,
        expectedRightBindingVersion: 1,
        expectedMappingVersion: version,
        reason: '核对两个账号属于同一人',
      },
      by.actorId,
    )
  assert.equal(a.matchAuthors('p', e1, e2).matched, false)
  confirm(e1, e2)
  confirm(e2, e3)
  assert.equal(a.matchAuthors('p', e1, e2).matched, true)
  assert.equal(
    a.matchAuthors('p', e1, e3).matched,
    false,
    'no transitive identities',
  )
  const e4 = add(grants[0]!.id, 'a2'),
    e5 = add(grants[1]!.id, 'b2')
  bind('task2', e4)
  bind('task2', e5)
  assert.equal(
    a.matchAuthors('p', e4, e5).matched,
    true,
    'project direct pair reusable with independent task bindings',
  )
  const mapped = a.identityMappings({ projectId: 'p', taskId: 'task2' })
    .mappings[0]!
  a.revokeIdentityMapping(
    {
      projectId: 'p',
      taskId: 'task2',
      id: mapped.id,
      expectedVersion: 1,
      reason: '撤销跨来源确认',
    },
    by.actorId,
  )
  assert.equal(a.mappingCurrent('p', mapped.id, 1), false)
  assert.equal(a.matchAuthors('p', e1, e2).matched, false)
  assert.throws(() => confirm(e1, e2, 0), /ASSOCIATION_CONFLICT/)
  confirm(e1, e2, 2)
  assert.equal(a.matchAuthors('p', e1, e2).mappingVersion, 3)
  const exported = a.exportForTasks('p', ['task2'], false)
  assert.equal(exported.mappings.length, 1)
  assert.equal(
    exported.audits.filter((x) => x.entityId === mapped.id).length,
    3,
  )
  assert.equal(JSON.stringify(exported).includes('真实来源记录'), false)
  assert.equal(a.sourceEvents({ projectId: 'p', limit: 2 }).events.length, 2)
  let page = a.sourceEvents({ projectId: 'p', limit: 2 }),
    seen = page.events.map((e) => e.id)
  assert.throws(
    () => a.sourceEvents({ projectId: 'q', cursor: page.nextCursor! }),
    /ASSOCIATION_INVALID_CURSOR/,
  )
  const rollbackEvent = add(grants[0]!.id, 'rollback')
  const beforeCount = a.sourceBindings({ projectId: 'p', taskId: 'task2' })
    .bindings.length
  assert.throws(
    () =>
      a.bindSourceObject(
        {
          projectId: 'p',
          taskId: 'task2',
          eventId: rollbackEvent,
          expectedTaskVersion: 1,
          expectedCriteriaVersion: 0,
          expectedManualVersion: 1,
          reason: '选择',
        },
        'automatic',
      ),
    /ASSOCIATION_INVALID_INPUT/,
  )
  assert.equal(
    a.sourceBindings({ projectId: 'p', taskId: 'task2' }).bindings.length,
    beforeCount,
    'invalid actor rolls back binding and audit',
  )
  const currentTask = store.tasks.get('p', 'task2')!
  assert.throws(
    () =>
      a.bindSourceObject(
        {
          projectId: 'p',
          taskId: 'task2',
          eventId: rollbackEvent,
          expectedTaskVersion: currentTask.version + 1,
          expectedCriteriaVersion: currentTask.criteriaVersion,
          expectedManualVersion: currentTask.manualVersion,
          reason: '过期事项',
        },
        by.actorId,
      ),
    /ASSOCIATION_CONFLICT/,
  )
  const later = add(grants[0]!.id, 'later')
  while (page.nextCursor) {
    page = a.sourceEvents({ projectId: 'p', limit: 2, cursor: page.nextCursor })
    seen.push(...page.events.map((e) => e.id))
  }
  assert.equal(new Set(seen).size, seen.length)
  assert.ok(!seen.includes(later))
  assert.ok(!seen.includes(q))
  a.revokeSourceBinding(
    {
      projectId: 'p',
      taskId: 'task',
      id: bs[0]!.id,
      expectedVersion: 1,
      reason: '取消对象关联',
    },
    by.actorId,
  )
  assert.equal(a.bindingCurrent('p', 'task', bs[0]!.id, 1), false)
  assert.equal(
    a.primaryEventId('p', 'task'),
    e1,
    'canonical anchor never silently changes',
  )
  assert.equal(
    store.tasks.get('p', 'task')!.version,
    task.version,
    'associations do not alter task facts',
  )
  // Rule-origin association cannot be reassigned or revoked, and is stable across VACUUM.
  const ruleEvent = add(
    grants[0]!.id,
    'rule',
    'person',
    '我会提交完整测试报告。',
  )
  for (let i = 0; i < 50; i++) {
    const j = store.processing.claim()
    if (!j) break
    const c = store.processing.load(j)!
    store.processing.commit(
      j,
      c,
      prepareEventProcessing({
        event: c.event,
        eventId: c.eventId,
        projectId: c.projectId,
      }),
    )
  }
  const origin = db
    .prepare(
      'SELECT task_id FROM processing_origins WHERE project_id=? AND external_id=?',
    )
    .get('p', 'rule') as { task_id: string }
  const rb = a.sourceBindings({ projectId: 'p', taskId: origin.task_id })
    .bindings[0]!
  assert.equal(rb.baselineEventId, ruleEvent)
  assert.equal(rb.origin, 'rule')
  assert.throws(() => bind('task2', ruleEvent), /ASSOCIATION_CONFLICT/)
  assert.throws(
    () =>
      a.revokeSourceBinding(
        {
          projectId: 'p',
          taskId: origin.task_id,
          id: rb.id,
          expectedVersion: 1,
          reason: '不能撤销规则来源',
        },
        by.actorId,
      ),
    /ASSOCIATION_CONFLICT/,
  )
  db.exec('VACUUM')
  assert.equal(
    a.sourceBindings({ projectId: 'p', taskId: origin.task_id }).bindings[0]!
      .id,
    rb.id,
  )
  const target = add(grants[0]!.id, 'retracted')
  add(grants[0]!.id, 'retracted', 'person', '', 'retract')
  assert.throws(() => bind('task2', target), /ASSOCIATION_UNAVAILABLE/)
  const audit = db
    .prepare('SELECT * FROM source_association_audit LIMIT 1')
    .get() as { id: number; after_json: string }
  db.prepare('UPDATE source_association_audit SET after_json=? WHERE id=?').run(
    JSON.stringify({ ...JSON.parse(audit.after_json), secret: 'never export' }),
    audit.id,
  )
  assert.throws(() => a.audit(audit.id), /ASSOCIATION_CORRUPT_DATA/)
  db.prepare('UPDATE source_association_audit SET after_json=? WHERE id=?').run(
    audit.after_json,
    audit.id,
  )
  console.log('source-associations-integration: passed')
} finally {
  db.close()
  store.close()
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
}

import { commitHistoricalFixture } from './fixtures/legacy-rule-task'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { TimelineEntry, TimelinePage, SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-timeline-')),
  path = join(dir, 'test.sqlite'),
  store = openStore(path),
  db = new Database(path)
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const actor = { actorId: 'local-user', reason: 'Synthetic manual edit' }
  store.tasks.create({ id: 'manual', projectId: 'a', title: 'Initial' }, actor)
  store.tasks.create(
    { id: 'other', projectId: 'b', title: 'Other project' },
    actor,
  )
  const update = () => {
    const t = store.tasks.get('a', 'manual')!
    return store.tasks.update(
      {
        projectId: 'a',
        taskId: t.id,
        expectedVersion: t.version,
        expectedCriteriaVersion: t.criteriaVersion,
        expectedManualVersion: t.manualVersion,
      },
      { title: `Revision ${t.version + 1}` },
      actor,
    )
  }
  for (let i = 0; i < 121; i++) update()
  const first = store.timeline.list({
    projectId: 'a',
    taskId: 'manual',
    limit: 7,
  })
  assert.equal(first.entries.length, 7)
  assert.ok(first.nextCursor)
  const snapshotKeys = new Set(first.entries.map((e) => e.key))
  update()
  db.prepare(
    "UPDATE decisions SET created_at='2000-01-01T00:00:00.000Z' WHERE task_id='manual' AND id=(SELECT max(id) FROM decisions)",
  ).run()
  let cursor: string | null = first.nextCursor
  while (cursor) {
    const page: TimelinePage = store.timeline.list({
      projectId: 'a',
      taskId: 'manual',
      cursor,
      limit: 13,
    })
    for (const e of page.entries) {
      assert.ok(!snapshotKeys.has(e.key))
      snapshotKeys.add(e.key)
    }
    cursor = page.nextCursor
  }
  assert.equal(snapshotKeys.size, 122)
  const all: TimelineEntry[] = []
  cursor = null
  do {
    const page: TimelinePage = store.timeline.list({
      projectId: 'a',
      taskId: 'manual',
      ...(cursor ? { cursor } : {}),
      limit: 50,
    })
    all.push(...page.entries)
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(all.length, 123)
  assert.ok(
    all.some((e) =>
      e.changes.some(
        (c) =>
          c.field === 'title' &&
          c.before === 'Initial' &&
          c.after === 'Revision 2',
      ),
    ),
  )
  assert.throws(
    () => store.timeline.list({ projectId: 'b', taskId: 'manual' }),
    /NOT_FOUND/,
  )
  assert.throws(
    () =>
      store.timeline.list({
        projectId: 'b',
        taskId: 'other',
        cursor: first.nextCursor!,
      }),
    /TIMELINE_INVALID_CURSOR/,
  )
  assert.throws(
    () =>
      store.timeline.list({
        projectId: 'a',
        taskId: 'manual',
        cursor: 'A'.repeat(4097),
      }),
    /TIMELINE_INVALID_CURSOR/,
  )
  assert.throws(
    () =>
      store.timeline.list({
        projectId: 'a',
        taskId: 'manual',
        cursor: Buffer.from('{"v":1}').toString('base64url'),
      }),
    /TIMELINE_INVALID_CURSOR/,
  )
  assert.throws(
    () => store.timeline.list({ projectId: 'a', taskId: 'manual', limit: 51 }),
    /TIMELINE_INVALID_INPUT/,
  )
  const latest = db
    .prepare(
      "SELECT id,payload FROM decisions WHERE task_id='manual' ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .get() as { id: number; payload: string }
  db.prepare('UPDATE decisions SET payload=? WHERE id=?').run(
    '{"token":"DO_NOT_EXPOSE"}',
    latest.id,
  )
  assert.throws(
    () => store.timeline.list({ projectId: 'a', taskId: 'manual' }),
    /TIMELINE_CORRUPT_DATA/,
  )
  db.prepare('UPDATE decisions SET payload=? WHERE id=?').run(
    latest.payload,
    latest.id,
  )
  store.tasks.create(
    { id: 'large', projectId: 'a', title: 'Large criteria audit' },
    actor,
  )
  for (let n = 0; n < 20; n++) {
    const t = store.tasks.get('a', 'large')!
    store.tasks.replaceCriteria(
      {
        projectId: 'a',
        taskId: 'large',
        expectedVersion: t.version,
        expectedCriteriaVersion: t.criteriaVersion,
        expectedManualVersion: t.manualVersion,
      },
      Array.from({ length: 31 }, (_, i) => ({
        id: `c${i}`,
        description: `${n}:` + 'x'.repeat(498),
      })),
      actor,
    )
  }
  const large = store.timeline.list({
    projectId: 'a',
    taskId: 'large',
    limit: 50,
  })
  assert.ok(large.entries.length < 21 && large.nextCursor)
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 512 * 1024)
  let largeCount = large.entries.length,
    largeCursor: string | null = large.nextCursor
  while (largeCursor) {
    const p: TimelinePage = store.timeline.list({
      projectId: 'a',
      taskId: 'large',
      limit: 50,
      cursor: largeCursor,
    })
    largeCount += p.entries.length
    largeCursor = p.nextCursor
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 512 * 1024)
  }
  assert.equal(largeCount, 21)
  store.tasks.create(
    { id: 'due', projectId: 'a', title: 'Date normalization' },
    actor,
  )
  for (const dueAt of [
    '2026-09-15T12:00:00Z',
    '2026-09-15T12:00:00.1Z',
    '2026-09-15T12:00:00.12Z',
    null,
  ]) {
    const t = store.tasks.get('a', 'due')!
    store.tasks.update(
      {
        projectId: 'a',
        taskId: 'due',
        expectedVersion: t.version,
        expectedCriteriaVersion: t.criteriaVersion,
        expectedManualVersion: t.manualVersion,
      },
      { dueAt },
      actor,
    )
  }
  const dueHistory = store.timeline.list({ projectId: 'a', taskId: 'due' })
  assert.equal(dueHistory.entries.length, 5)
  assert.ok(
    dueHistory.entries.some((e) =>
      e.changes.some(
        (c) => c.field === 'dueAt' && c.after === '2026-09-15T12:00:00.100Z',
      ),
    ),
  )
  const dueDecision = db
    .prepare(
      "SELECT id,payload FROM decisions WHERE task_id='due' AND scope='dueAt' ORDER BY id LIMIT 1",
    )
    .get() as { id: number; payload: string }
  for (const invalid of [
    '2026-02-30T12:00:00Z',
    '2026-09-15T12:00:00.0000Z',
    '2026-09-15T12:00:00+00:00',
  ]) {
    db.prepare('UPDATE decisions SET payload=? WHERE id=?').run(
      JSON.stringify({ dueAt: invalid }),
      dueDecision.id,
    )
    assert.throws(
      () => store.timeline.list({ projectId: 'a', taskId: 'due' }),
      /TIMELINE_CORRUPT_DATA/,
    )
  }
  db.prepare('UPDATE decisions SET payload=? WHERE id=?').run(
    dueDecision.payload,
    dueDecision.id,
  )
  const grant = store.sources.authorize({
    projectId: 'a',
    path: join(dir, 'synthetic.jsonl'),
  })
  const base: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'object',
    revision: '1',
    occurredAt: '2026-09-13T09:00:00Z',
    role: 'user',
    text: '我会提交审计文档。',
  }
  function ingest(e: SourceEvent) {
    const g = store.sources.getAuthorized(grant.id)
    store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [e],
      e.revision,
      g.cursor,
    )
    return (
      db
        .prepare(
          'SELECT id FROM source_events WHERE source_id=? AND revision=?',
        )
        .get(grant.id, e.revision) as { id: number }
    ).id
  }
  const baseId = ingest(base)
  db.prepare('UPDATE decisions SET input_refs=? WHERE id=?').run(
    JSON.stringify([baseId]),
    latest.id,
  )
  assert.throws(
    () => store.timeline.list({ projectId: 'a', taskId: 'manual' }),
    /TIMELINE_CORRUPT_DATA/,
  )
  db.prepare("UPDATE decisions SET input_refs='[]' WHERE id=?").run(latest.id)
  const now = new Date('2026-09-14T00:00:00Z'),
    job = store.processing.claim(now)!,
    context = store.processing.load(job, now)!
  const taskId = commitHistoricalFixture(
    store,
    path,
    job,
    context,
    prepareEventProcessing({
      event: context.event,
      eventId: context.eventId,
      projectId: 'a',
    }),
    now,
  ).taskIds[0]!
  const refId = String(
    (
      db
        .prepare('SELECT id FROM processing_evidence WHERE task_id=?')
        .get(taskId) as { id: number }
    ).id,
  )
  const editId = ingest({ ...base, revision: '2', text: 'x'.repeat(2000) })
  const input = {
      projectId: 'a',
      taskId,
      referenceKind: 'processing' as const,
      referenceId: refId,
    },
    review = store.revisionReview.reviewReference(input)
  store.revisionReview.confirmReference(
    {
      ...input,
      chosenEventId: editId,
      expectedReferenceVersion: review.reference.version,
      knownContentSetDigest: review.knownContentSetDigest,
      reason: 'Read this known version',
    },
    'local-user',
  )
  ingest({ ...base, revision: '3', text: 'later content' })
  ingest({ ...base, revision: '4', operation: 'retract', text: '' })
  const page: TimelinePage = store.timeline.list({
    projectId: 'a',
    taskId,
    limit: 50,
  })
  assert.deepEqual(
    new Set(page.entries.map((e) => e.kind)),
    new Set([
      'rule',
      'reference_conflict',
      'reference_confirmation',
      'retraction',
    ]),
  )
  assert.equal(
    page.entries.filter((e) => e.kind === 'reference_conflict').length,
    2,
  )
  const proof = page.entries.find(
    (e) => e.kind === 'reference_conflict' && e.evidence?.eventId === editId,
  )!.evidence!
  assert.equal(proof.excerpt.length, 1024)
  assert.equal(proof.excerptTruncated, true)
  assert.equal(
    page.entries.find((e) => e.kind === 'retraction')!.timeBasis,
    'event_received',
  )
  assert.equal(
    page.entries.find((e) => e.kind === 'reference_confirmation')!.actor.id,
    'local-user',
  )
  store.sources.revoke(grant.id)
  assert.ok(
    store.timeline
      .list({ projectId: 'a', taskId })
      .entries.filter((e) => e.evidence)
      .every((e) => e.evidence!.sourceStatus === 'revoked'),
  )
  // Corrupt an audit proof to reference another object in the same project: never treat it as valid history.
  const a = db
    .prepare('SELECT id,new_digest FROM reference_revision_audit LIMIT 1')
    .get() as { id: number; new_digest: string }
  db.prepare('UPDATE reference_revision_audit SET new_digest=? WHERE id=?').run(
    'bad-digest',
    a.id,
  )
  assert.throws(
    () => store.timeline.list({ projectId: 'a', taskId }),
    /TIMELINE_CORRUPT_DATA/,
  )
  db.prepare('UPDATE reference_revision_audit SET new_digest=? WHERE id=?').run(
    a.new_digest,
    a.id,
  )
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024)
  console.log(
    'Timeline integration passed: snapshot paging, isolation, manual diffs, rule/conflict/confirmation/retraction, corruption',
  )
} finally {
  db.close()
  store.close()
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  } catch {}
}

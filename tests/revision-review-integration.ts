import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-edit-review-')),
  path = join(dir, 'test.sqlite')
const store = openStore(path),
  db = new Database(path)
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const grant = store.sources.authorize({
    path: join(dir, 'fictional.jsonl'),
    projectId: 'a',
  })
  const base: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'object',
    revision: '9',
    occurredAt: '2026-09-13T09:00:00Z',
    role: 'user',
    text: '我会提交修复 PR。',
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
  }
  const now = new Date('2026-09-14T09:00:00Z')
  ingest(base)
  const job = store.processing.claim(now)!,
    c = store.processing.load(job, now)!
  const taskId = store.processing.commit(
    job,
    c,
    prepareEventProcessing({
      event: c.event,
      eventId: c.eventId,
      projectId: c.projectId,
    }),
    now,
  ).taskIds[0]!
  const original = store.tasks.get('a', taskId)
  const referenceId = String(
    (
      db
        .prepare('SELECT id FROM processing_evidence WHERE task_id=?')
        .get(taskId) as { id: number }
    ).id,
  )
  const input = {
    projectId: 'a',
    taskId,
    referenceKind: 'processing' as const,
    referenceId,
  }
  const api = store.revisionReview
  db.prepare(
    "UPDATE processing_evidence SET reference_status='invalidated' WHERE id=?",
  ).run(referenceId)
  assert.throws(() => api.reviewReference(input), /INVALID_RETRACTION_DATA/)
  assert.throws(
    () => api.listReferences({ projectId: 'a', taskId }),
    /INVALID_RETRACTION_DATA/,
  )
  db.prepare(
    "UPDATE processing_evidence SET reference_status='available' WHERE id=?",
  ).run(referenceId)
  const initial = api.reviewReference(input)
  assert.equal(initial.reference.status, 'available')
  ingest({ ...base, revision: '8' })
  assert.equal(
    api.reviewReference(input).reference.version,
    initial.reference.version,
  )
  store.processing.setEnabled(false)
  ingest({ ...base, revision: '2', text: '我会编写回归测试。' })
  let view = api.reviewReference(input)
  assert.equal(view.reference.status, 'review_required')
  const savedReview = db
    .prepare(
      "SELECT * FROM reference_revision_reviews WHERE reference_kind='processing' AND reference_id=?",
    )
    .get(referenceId) as Record<string, string | number | null>
  db.prepare(
    "DELETE FROM reference_revision_reviews WHERE reference_kind='processing' AND reference_id=?",
  ).run(referenceId)
  assert.throws(() => api.reviewReference(input), /INVALID_REFERENCE_REVIEW/)
  assert.throws(
    () => api.listReferences({ projectId: 'a', taskId }),
    /INVALID_REFERENCE_REVIEW/,
  )
  db.prepare(
    'INSERT INTO reference_revision_reviews VALUES(?,?,?,?,?,?,?,?,?)',
  ).run(...Object.values(savedReview))

  db.prepare(
    "UPDATE reference_revision_reviews SET status='available' WHERE reference_kind='processing' AND reference_id=?",
  ).run(referenceId)
  assert.throws(() => api.reviewReference(input), /INVALID_REFERENCE_REVIEW/)
  db.prepare(
    "UPDATE reference_revision_reviews SET status='review_required' WHERE reference_kind='processing' AND reference_id=?",
  ).run(referenceId)
  assert.equal(
    store.processing.getTaskEvidence('a', taskId)[0]!.referenceStatus,
    'invalidated',
  )
  const selected = view.events.find((e) => e.revision === '2')!.id
  const confirm = {
    ...input,
    chosenEventId: selected,
    knownContentSetDigest: view.knownContentSetDigest,
    expectedReferenceVersion: view.reference.version,
    reason: 'Reviewed this message version',
  }
  assert.throws(
    () => api.confirmReference({ ...confirm, projectId: 'b' }, 'local-user'),
    /INVALID_REFERENCE_REVIEW/,
  )
  db.exec(
    "CREATE TRIGGER reject_review BEFORE INSERT ON reference_revision_decisions BEGIN SELECT RAISE(ABORT,'fixture'); END",
  )
  assert.throws(() => api.confirmReference(confirm, 'local-user'), /fixture/)
  assert.equal(
    api.reviewReference(input).reference.version,
    view.reference.version,
  )
  assert.equal(api.reviewReference(input).reference.status, 'review_required')
  db.exec('DROP TRIGGER reject_review')
  const confirmed = api.confirmReference(confirm, 'local-user')
  assert.equal(confirmed.reference.status, 'confirmed')
  assert.equal(confirmed.confirmation!.eventId, selected)
  assert.equal(confirmed.confirmation!.role, 'user')
  assert.throws(
    () => api.confirmReference(confirm, 'local-user'),
    /REFERENCE_REVIEW_CONFLICT/,
  )
  ingest({ ...base, revision: '8' })
  assert.equal(api.reviewReference(input).reference.status, 'confirmed')
  ingest({ ...base, revision: 'copy-new', text: '我会编写回归测试。' })
  assert.equal(api.reviewReference(input).reference.status, 'confirmed')
  assert.equal(
    store.processing.getTaskEvidence('a', taskId)[0]!.referenceStatus,
    'invalidated',
  )
  ingest({ ...base, revision: '1', text: '我会补充文档。' })
  assert.equal(api.reviewReference(input).reference.status, 'review_required')
  assert.throws(
    () =>
      api.confirmReference(
        { ...confirm, expectedReferenceVersion: confirmed.reference.version },
        'local-user',
      ),
    /REFERENCE_REVIEW_CONFLICT/,
  )
  assert.deepEqual(store.tasks.get('a', taskId), original)
  const eventId = initial.reference.eventId
  db.prepare('INSERT INTO criterion_sets VALUES(?,1)').run(taskId)
  db.prepare(
    "INSERT INTO criteria VALUES(?,'a',1,'c','Fictional criterion',NULL)",
  ).run(taskId)
  for (const validity of ['valid', 'unknown', 'invalid'])
    db.prepare(
      "INSERT INTO evidence_links VALUES(?,?,'a',1,'c',?,'supports',?,'Original human reason')",
    ).run(validity, taskId, eventId, validity)
  api.observe('a', eventId)
  for (const validity of ['valid', 'unknown', 'invalid']) {
    const ref = {
      ...input,
      referenceKind: 'manual' as const,
      referenceId: validity,
    }
    const r = api.reviewReference(ref)
    const request = {
      ...ref,
      chosenEventId: eventId,
      knownContentSetDigest: r.knownContentSetDigest,
      expectedReferenceVersion: r.reference.version,
      reason: 'Choose original known content',
    }
    if (validity === 'invalid')
      assert.throws(
        () => api.confirmReference(request, 'local-user'),
        /REFERENCE_ALREADY_INVALID/,
      )
    else {
      api.confirmReference(request, 'local-user')
      assert.equal(
        (
          db
            .prepare('SELECT validity FROM evidence_links WHERE id=?')
            .get(validity) as { validity: string }
        ).validity,
        validity,
      )
    }
  }
  assert.equal(
    api.listReferences({ projectId: 'a', taskId }).references.length,
    4,
  )
  const manual = {
    ...input,
    referenceKind: 'manual' as const,
    referenceId: 'valid',
  }
  const manualReview = api.reviewReference(manual)
  const selectedManual = api.confirmReference(
    {
      ...manual,
      chosenEventId: selected,
      knownContentSetDigest: manualReview.knownContentSetDigest,
      expectedReferenceVersion: manualReview.reference.version,
      reason: 'Use edited message',
    },
    'local-user',
  )
  assert.equal(selectedManual.confirmation!.validity, 'valid')
  assert.equal(selectedManual.reference.originalReferenceStatus, 'invalidated')
  assert.equal(
    (
      db
        .prepare("SELECT validity FROM evidence_links WHERE id='valid'")
        .get() as { validity: string }
    ).validity,
    'invalid',
  )
  const page1 = api.reviewReference({ ...input, limit: 1 })
  assert.ok(page1.nextCursor)
  const page2 = api.reviewReference({
    ...input,
    limit: 1,
    cursor: page1.nextCursor!,
  })
  assert.notEqual(page1.events[0]!.id, page2.events[0]!.id)
  const reopened = openStore(path)
  assert.deepEqual(
    reopened.revisionReview.reviewReference(manual),
    api.reviewReference(manual),
  )
  reopened.close()
  const beforeRole = api.reviewReference(input)
  ingest({ ...base, revision: 'role-change', role: 'assistant' })
  assert.ok(
    api.reviewReference(input).events.some((e) => e.role === 'assistant'),
  )
  assert.notEqual(
    api.reviewReference(input).knownContentSetDigest,
    beforeRole.knownContentSetDigest,
  )
  for (let n = 0; n < 4; n++)
    ingest({
      ...base,
      revision: 'large-' + n,
      text: String(n) + '\u0001'.repeat(65535),
    })
  const allIds: number[] = []
  let cursor: string | undefined
  do {
    const page = api.reviewReference({
      ...input,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    })
    assert.ok(page.events.length > 0)
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') < 1024 * 1024)
    allIds.push(...page.events.map((e) => e.id))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(new Set(allIds).size, allIds.length)
  assert.equal(
    allIds.length,
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM source_events WHERE operation='upsert'",
        )
        .get() as { n: number }
    ).n,
  )
  const ready = api.reviewReference(input)
  const good = api.confirmReference(
    {
      ...input,
      chosenEventId: eventId,
      knownContentSetDigest: ready.knownContentSetDigest,
      expectedReferenceVersion: ready.reference.version,
      reason: 'Review known set',
    },
    'local-user',
  )
  ingest({ ...base, externalId: 'unrelated', revision: 'foreign' })
  const foreign = (
    db
      .prepare("SELECT id FROM source_events WHERE external_id='unrelated'")
      .get() as { id: number }
  ).id
  db.prepare(
    "UPDATE reference_revision_reviews SET selected_event_id=? WHERE reference_kind='processing' AND reference_id=?",
  ).run(foreign, referenceId)
  db.prepare(
    "UPDATE reference_revision_decisions SET chosen_event_id=? WHERE reference_kind='processing' AND reference_id=? AND reference_version=?",
  ).run(foreign, referenceId, good.reference.version)
  assert.throws(() => api.reviewReference(input), /INVALID_REFERENCE_REVIEW/)
  db.prepare(
    "UPDATE reference_revision_reviews SET selected_event_id=? WHERE reference_kind='processing' AND reference_id=?",
  ).run(eventId, referenceId)
  db.prepare(
    "UPDATE reference_revision_decisions SET chosen_event_id=? WHERE reference_kind='processing' AND reference_id=? AND reference_version=?",
  ).run(eventId, referenceId, good.reference.version)
  ingest({ ...base, revision: 'retracted', operation: 'retract', text: '' })
  view = api.reviewReference(input)
  assert.equal(view.reference.status, 'invalidated')
  assert.throws(
    () =>
      api.confirmReference(
        {
          ...confirm,
          knownContentSetDigest: view.knownContentSetDigest,
          expectedReferenceVersion: view.reference.version,
        },
        'local-user',
      ),
    /REFERENCE_RETRACTED/,
  )
  const insert = db.prepare(
    "INSERT INTO source_events(source_id,external_id,revision,occurred_at,received_at,role,content,operation) VALUES(?,'large-history',?,'2026-09-13T09:00:00Z','2026-09-13T09:00:01Z','user',?,'upsert')",
  )
  const associate = db.prepare("INSERT INTO event_projects VALUES('a',?)")
  let largeFirst = 0
  db.transaction(() => {
    for (let n = 0; n < 10001; n++) {
      const result = insert.run(grant.id, String(n), 'Version ' + n)
      if (!n) largeFirst = Number(result.lastInsertRowid)
      associate.run(result.lastInsertRowid)
    }
  })()
  db.prepare(
    "INSERT INTO evidence_links VALUES('large-history',?,'a',1,'c',?,'supports','valid','Legacy fixture')",
  ).run(taskId, largeFirst)
  db.exec(
    'DROP TABLE reference_revision_decisions; DROP TABLE reference_revision_reviews; PRAGMA user_version=10',
  )
  const migrated = openStore(path)
  const large = migrated.revisionReview.reviewReference({
    ...input,
    referenceKind: 'manual',
    referenceId: 'large-history',
    limit: 1,
  })
  assert.equal(large.reference.status, 'review_required')
  assert.equal(large.events.length, 1)
  assert.ok(large.nextCursor)
  assert.equal(db.pragma('user_version', { simple: true }), 11)
  migrated.close()
  console.log('revision review integration passed')
} finally {
  db.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

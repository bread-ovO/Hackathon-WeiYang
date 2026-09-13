import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore, type StoredTask } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-github-store-')),
  path = join(dir, 'test.sqlite')
let store = openStore(path)
const db = new Database(path)
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const github = store.github
  const credential = '00000000-0000-4000-8000-000000000001'
  assert.deepEqual(github.getCooldown(credential), {
    notBefore: 0,
    failureCount: 0,
  })
  assert.deepEqual(
    github.recordCooldown({ credentialId: credential, notBefore: 90000 }),
    { notBefore: 90000, failureCount: 1 },
  )
  assert.deepEqual(
    github.recordCooldown({ credentialId: credential, notBefore: 80000 }),
    { notBefore: 90000, failureCount: 2 },
  )
  assert.throws(() => github.getCooldown('not-uuid'), /GITHUB_INVALID_INPUT/)
  for (const notBefore of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER, 1.5])
    assert.throws(
      () => github.recordCooldown({ credentialId: credential, notBefore }),
      /GITHUB_INVALID_INPUT/,
    )
  db.prepare(
    'UPDATE github_credential_cooldowns SET failure_count=1000000 WHERE credential_id=?',
  ).run(credential)
  assert.equal(
    github.recordCooldown({ credentialId: credential, notBefore: 90001 })
      .failureCount,
    1000000,
  )
  const g = github.authorize({
    projectId: 'a',
    owner: 'OpenAI',
    repo: 'Codex',
    repositoryId: 1,
    credentialId: 'fictional-vault-ref',
  })
  assert.equal(g.owner, 'openai')
  assert.equal(g.repo, 'codex')
  assert.equal(g.status, 'active')
  assert.throws(
    () =>
      github.authorize({
        projectId: 'a',
        owner: 'openai',
        repo: 'codex',
        repositoryId: 1,
        credentialId: 'fictional',
      }),
    /GITHUB_DUPLICATE/,
  )
  const other = github.authorize({
    projectId: 'b',
    owner: 'openai',
    repo: 'codex',
    repositoryId: 1,
    credentialId: 'fictional',
  })
  const poll = github.getAuthorized(other.id)
  const empty = {
    id: other.id,
    expectedGrantVersion: poll.grantVersion,
    expectedPollVersion: poll.pollVersion,
    expectedCursor: '',
    events: [],
    nextCursor: '',
    nextPollAt: 100,
  }
  github.receiveBatch(empty)
  assert.throws(() => github.receiveBatch(empty), /GITHUB_POLL_CHANGED/)
  assert.equal(
    github.recordFailure({ ...empty, errorCode: 'GITHUB_REQUEST_FAILED' }),
    false,
  )
  const retry = {
    ...empty,
    expectedPollVersion: github.getAuthorized(other.id).pollVersion,
    errorCode: 'GITHUB_RATE_LIMITED' as const,
    nextPollAt: 90000,
  }
  assert.equal(github.recordFailure(retry), true)
  assert.equal(github.recordFailure(retry), false)
  assert.equal(github.getAuthorized(other.id).failureCount, 1)
  function event(revision: string, number = 1): SourceEvent {
    return {
      schemaVersion: 1,
      sourceInstanceId: g.id,
      externalId: `pr:${number}`,
      revision,
      occurredAt: '2026-09-13T09:00:00Z',
      role: 'tool',
      text: JSON.stringify({
        kind: 'github-pull-request',
        repository: 'openai/codex',
        repositoryId: 1,
        number,
        url: `https://github.com/OpenAI/Codex/pull/${number}`,
        state: 'open',
        title: 'Fictional PR ' + revision,
        draft: false,
        updatedAt: '2026-09-13T09:00:00Z',
        mergedAt: null,
        base: { repository: 'openai/codex', ref: 'main', sha: 'a'.repeat(40) },
        head: {
          repository: 'openai/codex',
          ref: 'feature',
          sha: 'b'.repeat(40),
          label: 'openai:feature',
        },
      }),
    }
  }
  const batch = (events: SourceEvent[], nextCursor = '', nextPollAt = 1000) => {
    const current = github.getAuthorized(g.id)
    return github.receiveBatch({
      id: g.id,
      expectedGrantVersion: current.grantVersion,
      expectedPollVersion: current.pollVersion,
      expectedCursor: current.cursor,
      events,
      nextCursor,
      nextPollAt,
    })
  }
  const first = event('1')
  assert.throws(() => store.receive(first, ''), /USE_AUTHORIZED_SOURCE_BATCH/)
  assert.equal(batch([first], '2').inserted, 1)
  for (let n = 0; n < 10; n++) assert.equal(batch([first], '2').duplicates, 1)
  assert.equal(github.records({ id: g.id }).records.length, 1)
  assert.equal(github.records({ id: other.id }).records.length, 0)
  assert.throws(
    () =>
      batch([
        {
          ...first,
          text: first.text.replace('"repositoryId":1', '"repositoryId":2'),
        },
      ]),
    /GITHUB_REPOSITORY_CHANGED/,
  )
  assert.throws(
    () =>
      batch([{ ...first, text: first.text.replace('Fictional', 'Changed') }]),
    /SOURCE_REVISION_CONFLICT/,
  )
  for (const patch of [
    { draft: 'bad' },
    { unexpected: 'x' },
    { updatedAt: 'invalid' },
    {
      head: {
        repository: 'openai/codex',
        ref: 'x',
        sha: 'not-sha',
        label: 'x',
      },
    },
  ])
    assert.throws(
      () =>
        batch([
          {
            ...first,
            revision: 'bad',
            text: JSON.stringify({ ...JSON.parse(first.text), ...patch }),
          },
        ]),
      /GITHUB_INVALID_RESPONSE/,
    )
  const rawEvent = (
    db.prepare('SELECT id FROM source_events WHERE source_id=?').get(g.id) as {
      id: number
    }
  ).id
  db.prepare("UPDATE source_events SET operation='retract' WHERE id=?").run(
    rawEvent,
  )
  assert.throws(
    () => github.records({ id: g.id }),
    /INVALID_SOURCE_EVENT|GITHUB_INVALID_INPUT/,
  )
  db.prepare("UPDATE source_events SET operation='upsert' WHERE id=?").run(
    rawEvent,
  )
  const before = github.getAuthorized(g.id)
  assert.throws(
    () =>
      github.receiveBatch({
        id: g.id,
        expectedGrantVersion: before.grantVersion,
        expectedPollVersion: before.pollVersion,
        expectedCursor: '',
        events: [],
        nextCursor: '',
        nextPollAt: 0,
      }),
    /GITHUB_CURSOR_CHANGED/,
  )
  assert.equal(
    github.recordFailure({
      id: g.id,
      expectedGrantVersion: before.grantVersion,
      expectedPollVersion: before.pollVersion,
      expectedCursor: '2',
      errorCode: 'GITHUB_RATE_LIMITED',
      nextPollAt: 90000,
    }),
    true,
  )
  const paused = github.setEnabled(g.id, false)
  assert.equal(paused.nextPollAt, 90000)
  assert.throws(
    () =>
      github.receiveBatch({
        id: g.id,
        expectedGrantVersion: before.grantVersion,
        expectedPollVersion: before.pollVersion,
        expectedCursor: '2',
        events: [],
        nextCursor: '',
        nextPollAt: 0,
      }),
    /GITHUB_GRANT_CHANGED/,
  )
  assert.equal(
    store.processing.claim(new Date('2026-09-14T00:00:00Z')),
    undefined,
  )
  const active = github.setEnabled(g.id, true)
  assert.equal(active.nextPollAt, 90000)
  // Transport failure never prevents processing already-authorized observations.
  const now = new Date('2026-09-14T00:00:00Z'),
    job = store.processing.claim(now)!
  assert.ok(job)
  db.prepare("INSERT INTO event_projects VALUES('b',?)").run(job.eventId)
  const context = store.processing.load(job, now)!
  assert.equal(context.projectId, 'a')
  assert.equal(context.grant.kind, 'github')
  const result = store.processing.commit(
    job,
    context,
    prepareEventProcessing({
      event: context.event,
      eventId: context.eventId,
      projectId: context.projectId,
    }),
    now,
  )
  assert.equal(result.outcome, 'ignored')
  assert.equal(result.taskIds.length, 0)
  store.ingestion.configure({ maxQueuedJobs: 1 })
  const beforePressure = github.getAuthorized(g.id)
  assert.throws(
    () => batch([event('2', 2), event('3', 3)], '3'),
    /INGESTION_QUEUE_LIMIT/,
  )
  assert.equal(github.getAuthorized(g.id).cursor, beforePressure.cursor)
  assert.equal(github.getAuthorized(g.id).eventCount, 1)
  store.ingestion.configure({ maxQueuedJobs: 100 })
  db.exec(
    "CREATE TRIGGER fail_github_commit BEFORE UPDATE OF next_poll_at ON github_connections BEGIN SELECT RAISE(ABORT,'fixture'); END",
  )
  assert.throws(() => batch([event('2', 2)], '3'), /fixture/)
  assert.equal(github.getAuthorized(g.id).eventCount, 1)
  assert.equal(github.getAuthorized(g.id).cursor, '2')
  db.exec('DROP TRIGGER fail_github_commit')
  batch([event('2', 2)], '3', 90001)
  const recordsPage = github.records({ id: g.id, limit: 1 })
  assert.equal(recordsPage.nextCursor, String(recordsPage.records[0]!.id))
  assert.equal(
    github.records({ id: g.id, cursor: recordsPage.nextCursor! }).records
      .length,
    1,
  )
  const by = { actorId: 'fictional-user', reason: 'Explicit manual setup' }
  const expected = (t: StoredTask) => ({
    projectId: 'a',
    taskId: t.id,
    expectedVersion: t.version,
    expectedCriteriaVersion: t.criteriaVersion,
    expectedManualVersion: t.manualVersion,
  })
  let task = store.tasks.create(
    { id: 'manual', projectId: 'a', title: 'Human task' },
    by,
  )
  task = store.tasks.replaceCriteria(
    expected(task),
    [{ id: 'c', description: 'PR observation', originEventId: job.eventId }],
    by,
  )
  task = store.tasks.addEvidence(
    expected(task),
    {
      id: 'manual-pr',
      criterionId: 'c',
      criteriaVersion: 1,
      eventId: job.eventId,
      relation: 'related',
      validity: 'unknown',
      reason: 'Observed PR',
    },
    by,
  )
  const taskBefore = store.tasks.get('a', 'manual')
  batch([event('edited')], '3', 90002)
  assert.equal(
    store.revisionReview.reviewReference({
      projectId: 'a',
      taskId: 'manual',
      referenceKind: 'manual',
      referenceId: 'manual-pr',
    }).reference.status,
    'review_required',
  )
  assert.deepEqual(store.tasks.get('a', 'manual'), taskBefore)
  assert.equal(
    store.exports.build({ projectId: 'a', includeSourceText: false }).events[0]!
      .sourceStatus,
    'active',
  )
  const snapshot = github.getAuthorized(g.id)
  store.close()
  store = openStore(path)
  assert.deepEqual(store.github.getAuthorized(g.id), snapshot)
  assert.deepEqual(store.github.getCooldown(credential), {
    notBefore: 90001,
    failureCount: 1000000,
  })
  const revoked = store.github.revoke(g.id)
  assert.equal(revoked.status, 'revoked')
  assert.equal(
    store.github.recordFailure({
      id: g.id,
      expectedGrantVersion: snapshot.grantVersion,
      expectedPollVersion: snapshot.pollVersion,
      expectedCursor: '3',
      errorCode: 'GITHUB_REQUEST_FAILED',
      nextPollAt: 100000,
    }),
    false,
  )
  assert.equal(store.processing.claim(now), undefined)
  assert.equal(store.github.records({ id: g.id }).records.length, 3)
  assert.equal(
    store.exports.build({ projectId: 'a', includeSourceText: false }).events[0]!
      .sourceStatus,
    'revoked',
  )
  const fresh = store.github.authorize({
    projectId: 'a',
    owner: 'openai',
    repo: 'codex',
    repositoryId: 1,
    credentialId: 'fictional',
  })
  assert.notEqual(fresh.id, g.id)
  assert.equal(fresh.eventCount, 0)
  store.ingestion.configure({ maxQueuedJobs: 1000 })
  const bulk = Array.from({ length: 100 }, (_, n) => {
    const value = event('bulk-' + n, n + 100)
    const payload = JSON.parse(value.text)
    payload.title = '测'.repeat(2048)
    payload.head.label = '分'.repeat(512)
    payload.base.ref = '支'.repeat(256)
    payload.head.ref = '支'.repeat(256)
    return {
      ...value,
      sourceInstanceId: fresh.id,
      text: JSON.stringify(payload),
    }
  })
  const auth = store.github.getAuthorized(fresh.id)
  store.github.receiveBatch({
    id: fresh.id,
    expectedGrantVersion: auth.grantVersion,
    expectedPollVersion: auth.pollVersion,
    expectedCursor: '',
    events: bulk,
    nextCursor: '',
    nextPollAt: 1000,
  })
  const page = store.github.records({ id: fresh.id, limit: 50 })
  assert.ok(page.nextCursor)
  assert.ok(Buffer.byteLength(JSON.stringify(page.records)) <= 512 * 1024)
  const seen = new Set(page.records.map((e) => e.id))
  let cursor: string | null = page.nextCursor
  while (cursor) {
    const next = store.github.records({ id: fresh.id, limit: 50, cursor })
    assert.ok(next.records.length)
    for (const e of next.records) {
      assert.ok(!seen.has(e.id))
      seen.add(e.id)
    }
    cursor = next.nextCursor
  }
  assert.equal(seen.size, 100)
  assert.equal(store.health().schemaVersion, 20)
  console.log('GitHub storage integration passed')
} finally {
  db.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

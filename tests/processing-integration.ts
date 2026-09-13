import { getSourceStatus } from '../packages/storage/src/source-status'
import { HTTP_JSON_MANIFEST_EXAMPLE } from '../packages/plugin-host/src/manifest'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { ProcessingContext } from '../packages/storage/src/processing'
const prepare = (context: ProcessingContext) =>
  prepareEventProcessing({
    event: context.event,
    eventId: context.eventId,
    projectId: context.projectId,
  })
import type { SourceEvent } from '@memo/contracts'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const folder = mkdtempSync(join(tmpdir(), 'bugu-processing-')),
  path = join(folder, 'store.sqlite')
let store: ReturnType<typeof openStore> | undefined
try {
  store = openStore(path)
  store.tasks.createProject('a', '项目甲')
  store.tasks.createProject('b', '项目乙')
  let grant = store.sources.authorize({
    path: join(folder, 'fake.jsonl'),
    projectId: 'a',
  })
  const event: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'm',
    revision: '1',
    occurredAt: '2026-09-13T09:00:00Z',
    role: 'user',
    text: '我会提交修复 PR。',
  }
  const ingest = (value: SourceEvent) => {
    const source = store!.sources.getAuthorized(grant.id)
    return store!.sources.receiveBatch(
      grant.id,
      source.grantVersion,
      [value],
      'cursor',
      source.cursor,
    )
  }
  for (let i = 0; i < 10; i++) ingest(event)
  const now = new Date('2026-09-14T09:00:00Z')
  let job = store.processing.claim(now)!
  assert.ok(job)
  let context = store.processing.load(job, now)!
  assert.equal(context.projectId, 'a')
  const proposal = prepare(context)
  const result = store.processing.commit(job, context, proposal, now)
  assert.equal(result.outcome, 'created')
  assert.equal(result.taskIds.length, 1)
  const id = result.taskIds[0]!
  for (let i = 0; i < 10; i++)
    assert.equal(
      store.processing.commit(job, context, proposal, now).outcome,
      'already_processed',
    )
  assert.throws(
    () =>
      store!.processing.commit(
        job,
        { ...context, projectId: 'b' },
        proposal,
        now,
      ),
    /PROCESSING_SOURCE_CHANGED/,
  )
  assert.equal(store.tasks.list('a').length, 1)
  assert.equal(store.processing.getStatus().processed, 1)
  assert.equal(store.tasks.get('a', id)!.manualVersion, 0)
  assert.equal(store.processing.getTaskEvidence('a', id)[0]!.quote, event.text)
  assert.equal(store.processing.getTaskEvidence('a', id)[0]!.actor, 'rule')
  assert.throws(
    () => store!.processing.getTaskEvidence('b', id),
    /TASK_NOT_IN_PROJECT/,
  )
  store.close()
  store = openStore(path)
  assert.equal(store.processing.claim(now), undefined)
  const original = store.tasks.get('a', id)!
  const edited = store.tasks.update(
    {
      projectId: 'a',
      taskId: id,
      expectedVersion: original.version,
      expectedCriteriaVersion: original.criteriaVersion,
      expectedManualVersion: original.manualVersion,
    },
    { title: '人工更正标题', status: 'waiting' },
    { actorId: 'human', reason: '虚构人工确认' },
  )
  ingest({ ...event, revision: '2', text: '我会提交另一个修复。' })
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  const changed = store.processing.commit(job, context, prepare(context), now)
  assert.equal(changed.outcome, 'review_required')
  assert.deepEqual(changed.taskIds, [id])
  assert.deepEqual(store.tasks.get('a', id), edited)
  assert.equal(store.tasks.list('a').length, 1)
  assert.equal(store.processing.getStatus().reviewRequired, 1)
  const evidence = store.processing.getTaskEvidence('a', id)
  assert.equal(evidence.length, 2)
  assert.equal(evidence[0]!.revisionStatus, 'review_required')
  assert.equal(evidence[1]!.quoteKind, 'revision_excerpt')
  assert.equal(evidence[0]!.quoteKind, 'exact')
  assert.equal(evidence[1]!.outcome, 'review_required')
  assert.equal(evidence[1]!.quote, '我会提交另一个修复。')
  // Extra event/project associations cannot change the source's authorized owner.
  ingest({ ...event, externalId: 'isolated' })
  const raw = new Database(path)
  raw.pragma('foreign_keys=ON')
  const e = (
    raw
      .prepare("SELECT id FROM source_events WHERE external_id='isolated'")
      .get() as { id: number }
  ).id
  store.tasks.assignEvent('b', e)
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  assert.equal(context.projectId, 'a')
  assert.throws(
    () =>
      store!.processing.commit(
        job,
        { ...context, projectId: 'b' },
        prepare({ ...context, projectId: 'b' }),
        now,
      ),
    /PROCESSING_SOURCE_CHANGED/,
  )
  assert.throws(
    () =>
      store!.processing.commit(
        job,
        context,
        { ...prepare(context), candidates: [] },
        now,
      ),
    /INVALID_PROCESSING_PROPOSAL/,
  )
  // Simulated crash midway through the transaction leaves no business changes.
  raw.exec(
    "CREATE TRIGGER reject_processing BEFORE INSERT ON processing_results BEGIN SELECT RAISE(ABORT,'PROCESSING_TEST_FAILURE'); END",
  )
  assert.throws(
    () => store!.processing.commit(job, context, prepare(context), now),
    /PROCESSING_TEST_FAILURE/,
  )
  assert.equal(store.tasks.list('a').length, 1)
  assert.equal(store.jobs.get(job.id)!.state, 'running')
  raw.exec('DROP TRIGGER reject_processing')
  const stale = job
  assert.equal(
    store.processing.release(stale, new Date(now.getTime() + 31000)),
    false,
  )
  assert.throws(
    () =>
      store!.processing.commit(
        stale,
        context,
        prepare(context),
        new Date(now.getTime() + 31000),
      ),
    /PROCESSING_LEASE_LOST/,
  )
  job = store.processing.claim(new Date(now.getTime() + 31000))!
  assert.ok(job.attempt > stale.attempt)
  assert.throws(
    () => store!.processing.commit(stale, context, prepare(context), now),
    /PROCESSING_LEASE_LOST/,
  )
  context = store.processing.load(job, new Date(now.getTime() + 31000))!
  store.processing.commit(
    job,
    context,
    prepare(context),
    new Date(now.getTime() + 31000),
  )
  assert.equal(store.tasks.list('a').length, 2)
  // Revocation leaves jobs unconsumed; a new grant invalidates old computation.
  ingest({ ...event, externalId: 'grant-race' })
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  store.sources.revoke(grant.id)
  assert.throws(
    () => store!.processing.commit(job, context, prepare(context), now),
    /PROCESSING_SOURCE_CHANGED/,
  )
  assert.equal(store.processing.release(job, now), true)
  assert.equal(store.processing.claim(now), undefined)
  assert.equal(
    store.processing.getTaskEvidence('a', id)[0]!.sourceStatus,
    'revoked',
  )
  grant = store.sources.authorize({
    path: join(folder, 'fake.jsonl'),
    projectId: 'a',
  })
  // Many UI pause/release cycles do not exhaust retries or recycle lease tokens.
  let last = job.attempt
  for (let i = 0; i < 5; i++) {
    job = store.processing.claim(now)!
    assert.ok(job.attempt > last)
    last = job.attempt
    context = store.processing.load(job, now)!
    store.processing.setEnabled(false)
    assert.throws(
      () => store!.processing.commit(job, context, prepare(context), now),
      /PROCESSING_DISABLED/,
    )
    assert.equal(store.processing.claim(now), undefined)
    store.processing.release(job, now)
    store.processing.setEnabled(true)
  }
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  store.processing.commit(job, context, prepare(context), now)
  assert.equal(store.tasks.list('a').length, 3)
  // A malformed old event cannot make failure bookkeeping reparse and throw.
  ingest({ ...event, externalId: 'legacy-bad' })
  raw
    .prepare(
      "UPDATE source_events SET role='user',occurred_at='bad-date' WHERE external_id='legacy-bad'",
    )
    .run()
  job = store.processing.claim(now)!
  assert.equal(store.processing.fail(job, 'INVALID_OUTPUT', false, now), true)
  assert.equal(store.jobs.get(job.id)!.state, 'failed')
  // Rule processing never masquerades as a manual decision.
  assert.equal(
    (raw.prepare('SELECT count(*) AS n FROM decisions').get() as { n: number })
      .n,
    1,
  )
  assert.equal(
    (
      raw
        .prepare(
          "SELECT count(*) AS n FROM processing_decisions WHERE actor='rule'",
        )
        .get() as { n: number }
    ).n,
    4,
  )
  // Plugin disabling/uninstalling also fences processing, even with retained events.
  const pluginInput = {
    id: HTTP_JSON_MANIFEST_EXAMPLE.id,
    projectId: 'b',
    displayName: HTTP_JSON_MANIFEST_EXAMPLE.displayName,
    version: HTTP_JSON_MANIFEST_EXAMPLE.version,
    digest: 'e'.repeat(64),
    manifest: HTTP_JSON_MANIFEST_EXAMPLE,
    grant: {
      kind: 'http-json' as const,
      domain: 'api.example.com',
      credentialId: 'fake-credential-reference',
    },
  }
  const installed = store.plugins.activate(pluginInput),
    plugin = store.plugins.get(installed.id)
  store.plugins.receiveBatch({
    id: installed.id,
    grantVersion: installed.grantVersion,
    expectedCursor: '',
    cursor: 'one',
    events: [
      {
        ...event,
        sourceInstanceId: plugin.sourceInstanceId,
        externalId: 'plugin',
      },
    ],
  })
  store.plugins.disable(installed.id)
  assert.equal(getSourceStatus(raw, 'b', plugin.sourceInstanceId), 'paused')
  assert.equal(getSourceStatus(raw, 'a', plugin.sourceInstanceId), 'unknown')
  assert.equal(store.processing.claim(now), undefined)
  store.plugins.activate(pluginInput)
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  assert.equal(context.projectId, 'b')
  assert.equal(context.grant.kind, 'plugin')
  const beforeGrant = context
  store.plugins.activate(pluginInput)
  assert.throws(
    () => store!.processing.commit(job, beforeGrant, prepare(beforeGrant), now),
    /PROCESSING_SOURCE_CHANGED/,
  )
  assert.equal(store.processing.release(job, now), true)
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  store.plugins.uninstall(installed.id)
  assert.equal(
    getSourceStatus(raw, 'b', plugin.sourceInstanceId),
    'uninstalled',
  )
  assert.equal(
    store.processing.fail(job, 'EXECUTION_FAILED', false, now),
    false,
  )
  assert.equal(store.processing.release(job, now), true)
  assert.equal(store.processing.claim(now), undefined)
  store.registerSource('ungranted')
  store.receive({ ...event, sourceInstanceId: 'ungranted' }, '')
  const unauthorizedId = (
    raw
      .prepare("SELECT id FROM source_events WHERE source_id='ungranted'")
      .get() as { id: number }
  ).id
  store.tasks.assignEvent('a', unauthorizedId)
  assert.equal(store.processing.claim(now), undefined)
  // Bounded history must retain the original exact quote and the newest revision.
  for (let revision = 3; revision <= 105; revision++) {
    ingest({
      ...event,
      revision: String(revision),
      text: `我会提交第${revision}份修订。`,
    })
    job = store.processing.claim(now)!
    context = store.processing.load(job, now)!
    store.processing.commit(job, context, prepare(context), now)
  }
  const latestEvidence = store.processing.getTaskEvidence('a', id)
  assert.equal(latestEvidence.length, 100)
  assert.equal(latestEvidence[0]!.revision, '1')
  assert.equal(latestEvidence[0]!.quoteKind, 'exact')
  assert.equal(latestEvidence[1]!.revision, '105')
  assert.equal(latestEvidence[1]!.quoteKind, 'revision_excerpt')
  raw.close()
  store.processing.setEnabled(false)
  store.close()
  store = openStore(path)
  assert.equal(store.processing.isEnabled(), false)
  console.log(
    'Processing integration passed: durable rule candidates, replay, revisions, human protection, grants, lease ABA and rollback',
  )
} finally {
  store?.close()
  try { rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch {}
}

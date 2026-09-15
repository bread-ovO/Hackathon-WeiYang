import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { ProcessingContext } from '../packages/storage/src/processing'
import type { SourceEvent } from '@memo/contracts'
const folder = mkdtempSync(join(tmpdir(), 'bugu-observation-')),
  path = join(folder, 'store.sqlite')
let store = openStore(path)
const raw = new Database(path)
const prepare = (c: ProcessingContext) =>
  prepareEventProcessing({
    event: c.event,
    eventId: c.eventId,
    projectId: c.projectId,
  })
try {
  store.tasks.createProject('a', '项目甲')
  store.tasks.createProject('b', '项目乙')
  let grant = store.sources.authorize({
    path: join(folder, 'synthetic.jsonl'),
    projectId: 'a',
  })
  const event: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'm',
    revision: '1',
    occurredAt: '2026-09-15T00:00:00Z',
    role: 'user',
    text: '我会提交修复 PR。',
  }
  const ingest = (value: SourceEvent) => {
    const g = store.sources.getAuthorized(grant.id)
    return store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [value],
      'cursor',
      g.cursor,
    )
  }
  for (let i = 0; i < 10; i++) ingest(event)
  const now = new Date('2026-09-16T00:00:00Z')
  let job = store.processing.claim(now)!,
    context = store.processing.load(job, now)!
  const proposal = prepare(context),
    result = store.processing.commit(job, context, proposal, now)
  assert.deepEqual(result, { outcome: 'ignored', taskIds: [] })
  for (let i = 0; i < 10; i++)
    assert.equal(
      store.processing.commit(job, context, proposal, now).outcome,
      'already_processed',
    )
  assert.equal(store.tasks.list('a').length, 0)
  assert.equal(store.processing.getStatus().processed, 1)
  assert.throws(
    () =>
      store.processing.commit(
        job,
        { ...context, projectId: 'b' },
        proposal,
        now,
      ),
    /PROCESSING_SOURCE_CHANGED/,
  )
  store.close()
  store = openStore(path)
  assert.equal(store.processing.claim(now), undefined)
  ingest({ ...event, externalId: 'fenced' })
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  assert.throws(
    () =>
      store.processing.commit(
        job,
        context,
        { ...prepare(context), candidates: [{ title: 'forged' }] } as never,
        now,
      ),
    /INVALID_PROCESSING_PROPOSAL/,
  )
  raw.exec(
    "CREATE TRIGGER reject_observation BEFORE INSERT ON processing_results BEGIN SELECT RAISE(ABORT,'TEST_ROLLBACK'); END",
  )
  assert.throws(
    () => store.processing.commit(job, context, prepare(context), now),
    /TEST_ROLLBACK/,
  )
  assert.equal(store.jobs.get(job.id)!.state, 'running')
  assert.equal(store.processing.getStatus().processed, 1)
  raw.exec('DROP TRIGGER reject_observation')
  const stale = job,
    later = new Date(now.getTime() + 31000)
  assert.equal(store.processing.release(stale, later), false)
  assert.throws(
    () => store.processing.commit(stale, context, prepare(context), later),
    /PROCESSING_LEASE_LOST/,
  )
  job = store.processing.claim(later)!
  assert(job.attempt > stale.attempt)
  assert.throws(
    () => store.processing.commit(stale, context, prepare(context), now),
    /PROCESSING_LEASE_LOST/,
  )
  context = store.processing.load(job, later)!
  store.processing.commit(job, context, prepare(context), later)
  ingest({ ...event, externalId: 'grant-race' })
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  store.sources.revoke(grant.id)
  assert.throws(
    () => store.processing.commit(job, context, prepare(context), now),
    /PROCESSING_SOURCE_CHANGED/,
  )
  assert(store.processing.release(job, now))
  assert.equal(store.processing.claim(now), undefined)
  grant = store.sources.authorize({
    path: join(folder, 'synthetic.jsonl'),
    projectId: 'a',
  })
  let last = job.attempt
  for (let i = 0; i < 5; i++) {
    job = store.processing.claim(now)!
    context = store.processing.load(job, now)!
    assert(job.attempt > last)
    last = job.attempt
    store.processing.setEnabled(false)
    assert.throws(
      () => store.processing.commit(job, context, prepare(context), now),
      /PROCESSING_DISABLED/,
    )
    assert.equal(store.processing.claim(now), undefined)
    assert(store.processing.release(job, now))
    store.processing.setEnabled(true)
  }
  job = store.processing.claim(now)!
  context = store.processing.load(job, now)!
  store.processing.commit(job, context, prepare(context), now)
  assert.equal(store.tasks.list('a').length, 0)
  assert.equal(
    (
      raw.prepare('SELECT count(*) AS n FROM processing_origins').get() as {
        n: number
      }
    ).n,
    0,
  )
  ingest({ ...event, externalId: 'bad' })
  raw
    .prepare(
      "UPDATE source_events SET occurred_at='bad-date' WHERE external_id='bad'",
    )
    .run()
  job = store.processing.claim(now)!
  assert(store.processing.fail(job, 'INVALID_OUTPUT', false, now))
  assert.equal(store.jobs.get(job.id)!.state, 'failed')
  store.processing.setEnabled(false)
  store.close()
  store = openStore(path)
  assert.equal(store.processing.isEnabled(), false)
  console.log(
    'Source observation: no rule creation, transactions, replay, grants, pause, lease fencing and recovery passed',
  )
} finally {
  raw.close()
  store.close()
  rmSync(folder, { recursive: true, force: true })
}

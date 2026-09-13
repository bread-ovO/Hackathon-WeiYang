import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-feishu-store-')),
  path = join(dir, 'test.sqlite')
let store = openStore(path)
const db = new Database(path),
  start = Date.parse('2026-09-12T00:00:00Z'),
  day = 86400000,
  credential = '00000000-0000-4000-8000-000000000001'
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const g = store.feishu.authorize({
    projectId: 'a',
    chatId: 'oc_synthetic',
    credentialId: credential,
    startTime: start,
    endTime: start + 3 * day,
  })
  assert.equal(g.windowEnd, start + day)
  assert.equal(g.windowStart, start)
  assert.equal(g.windowActive, true)
  assert.equal(g.completedThrough, null)
  assert.throws(
    () =>
      store.feishu.authorize({
        projectId: 'a',
        chatId: g.chatId,
        credentialId: credential,
        startTime: start,
        endTime: start + day,
      }),
    /FEISHU_DUPLICATE/,
  )
  for (const input of [
    { chatId: 'private' },
    { credentialId: 'bad' },
    { startTime: start + 1 },
    { endTime: start },
  ])
    assert.throws(
      () =>
        store.feishu.authorize({
          projectId: 'b',
          chatId: 'oc_other',
          credentialId: credential,
          startTime: start,
          endTime: start + day,
          ...input,
        }),
      /FEISHU_INVALID_INPUT/,
    )
  const other = store.feishu.authorize({
    projectId: 'b',
    chatId: g.chatId,
    credentialId: credential,
    startTime: start,
    endTime: start + day,
  })
  const fence = () => {
    const a = store.feishu.getAuthorized(g.id)
    return {
      id: g.id,
      expectedGrantVersion: a.grantVersion,
      expectedPollVersion: a.pollVersion,
    }
  }
  const event = (
    revision: string,
    externalId = 'message',
    text = '我会提交修复 PR。',
  ): SourceEvent => ({
    schemaVersion: 1,
    sourceInstanceId: g.id,
    externalId,
    revision,
    occurredAt: new Date(start + 1000).toISOString(),
    role: 'user',
    text,
  })
  function batch(events: SourceEvent[], nextPageToken: string) {
    const a = store.feishu.getAuthorized(g.id)
    return store.feishu.receiveBatch({
      ...fence(),
      expectedPageToken: a.pageToken,
      expectedWindowStart: a.windowStart,
      expectedWindowEnd: a.windowEnd,
      events,
      nextPageToken,
      nextPollAt: 0,
    })
  }
  const first = event('1')
  assert.throws(() => store.receive(first, ''), /USE_AUTHORIZED_SOURCE_BATCH/)
  assert.throws(
    () =>
      batch([{ ...first, occurredAt: new Date(start - 1).toISOString() }], 'A'),
    /FEISHU_INVALID_RESPONSE/,
  )
  assert.throws(
    () => batch([{ ...first, sourceInstanceId: other.id }], 'A'),
    /FEISHU_INVALID_INPUT/,
  )
  assert.throws(() => batch([], 'a b'), /FEISHU_INVALID_INPUT/)
  assert.equal(batch([first], 'x'.repeat(4096)).inserted, 1)
  assert.equal(batch([first], 'A').duplicates, 1)
  const failure = {
    ...fence(),
    errorCode: 'FEISHU_RATE_LIMITED' as const,
    nextPollAt: 90000,
  }
  assert.equal(store.feishu.recordFailure(failure), true)
  assert.equal(store.feishu.recordFailure(failure), false)
  assert.equal(store.feishu.getAuthorized(g.id).pageToken, 'A')
  assert.equal(store.feishu.getAuthorized(g.id).completedThrough, null)
  assert.throws(
    () =>
      store.feishu.receiveBatch({
        ...failure,
        expectedPageToken: 'A',
        expectedWindowStart: start,
        expectedWindowEnd: start + day,
        events: [],
        nextPageToken: 'B',
      }),
    /FEISHU_POLL_CHANGED/,
  )
  assert.equal(batch([first], 'B').duplicates, 1)
  store.close()
  store = openStore(path)
  assert.equal(store.feishu.getAuthorized(g.id).pageToken, 'B')
  assert.throws(() => batch([], 'A'), /FEISHU_PAGE_LOOP/)
  const now = new Date(start + 4 * day),
    job = store.processing.claim(now)!
  assert.ok(job)
  db.prepare("INSERT INTO event_projects VALUES('b',?)").run(job.eventId)
  const context = store.processing.load(job, now)!
  assert.equal(context.projectId, 'a')
  assert.equal(context.grant.kind, 'feishu')
  const taskId = store.processing.commit(
    job,
    context,
    prepareEventProcessing({
      event: context.event,
      eventId: context.eventId,
      projectId: context.projectId,
    }),
    now,
  ).taskIds[0]!
  const task = store.tasks.get('a', taskId)
  const reset = store.feishu.restartWindow(fence())
  assert.equal(reset.pageToken, '')
  assert.equal(reset.windowStart, start)
  assert.equal(reset.windowEnd, start + day)
  assert.ok(reset.nextPollAt > Date.now())
  assert.equal(reset.completedThrough, null)
  batch([event('2', 'message', '我会补充测试。')], 'A')
  assert.equal(
    store.processing.getTaskEvidence('a', taskId)[0]!.referenceStatus,
    'invalidated',
  )
  store.processing.setEnabled(false)
  batch([{ ...event('3'), operation: 'retract', text: '' }], 'B')
  assert.equal(
    store.processing.getTaskEvidence('a', taskId)[0]!.eventStatus,
    'retracted',
  )
  assert.deepEqual(store.tasks.get('a', taskId), task)
  const prior = store.feishu.getAuthorized(g.id)
  db.exec(
    "CREATE TRIGGER fail_feishu BEFORE UPDATE OF page_count ON feishu_connections BEGIN SELECT RAISE(ABORT,'fixture'); END",
  )
  assert.throws(() => batch([event('1', 'new')], 'C'), /fixture/)
  assert.equal(store.feishu.getAuthorized(g.id).eventCount, prior.eventCount)
  assert.equal(store.feishu.getAuthorized(g.id).pageToken, 'B')
  db.exec('DROP TRIGGER fail_feishu')
  store.ingestion.configure({ maxQueuedJobs: 1 })
  assert.throws(() => batch([event('1', 'new')], 'C'), /INGESTION_QUEUE_LIMIT/)
  assert.equal(store.feishu.getAuthorized(g.id).pageToken, 'B')
  store.ingestion.configure({ maxQueuedJobs: 1000 })
  const emptyFence = fence()
  const done = batch([], '')
  assert.equal(done.connection.completedThrough, start + day)
  assert.equal(done.connection.windowActive, false)
  assert.throws(
    () =>
      store.feishu.receiveBatch({
        ...emptyFence,
        expectedPageToken: 'B',
        expectedWindowStart: start,
        expectedWindowEnd: start + day,
        events: [],
        nextPageToken: '',
        nextPollAt: 0,
      }),
    /FEISHU_POLL_CHANGED/,
  )
  assert.throws(
    () => store.feishu.beginWindow({ ...fence(), until: start + day }),
    /FEISHU_NOT_DUE/,
  )
  const next = store.feishu.beginWindow({ ...fence(), until: start + 3 * day })
  assert.equal(next.windowStart, start + day - 120000)
  assert.equal(next.windowEnd, start + 2 * day)
  assert.equal(next.completedThrough, start + day)
  // Empty windows advance coverage, independent of event timestamps.
  batch([], '')
  assert.equal(
    store.feishu.getAuthorized(g.id).completedThrough,
    start + 2 * day,
  )
  store.feishu.beginWindow({ ...fence(), until: start + 3 * day })
  const advanced = store.feishu.getAuthorized(g.id)
  const pause = store.feishu.setEnabled(g.id, false)
  assert.equal(pause.windowStart, advanced.windowStart)
  assert.equal(pause.nextPollAt, advanced.nextPollAt)
  assert.throws(
    () => store.feishu.beginWindow({ ...fence(), until: start + 4 * day }),
    /FEISHU_DISABLED/,
  )
  store.feishu.setEnabled(g.id, true)
  db.prepare(
    'UPDATE feishu_connections SET page_count=10000 WHERE source_id=?',
  ).run(g.id)
  assert.throws(() => batch([], 'Z'), /FEISHU_PAGE_LIMIT/)
  const restart = store.feishu.restartWindow(fence())
  assert.equal(restart.windowStart, advanced.windowStart)
  assert.equal(restart.windowEnd, advanced.windowEnd)
  assert.equal(store.feishu.getCooldown(credential).notBefore, 0)
  store.feishu.recordCooldown({ credentialId: credential, notBefore: 90000 })
  assert.equal(
    store.feishu.recordCooldown({ credentialId: credential, notBefore: 1 })
      .notBefore,
    90000,
  )
  assert.throws(
    () =>
      store.feishu.recordCooldown({
        credentialId: credential,
        notBefore: Infinity,
      }),
    /FEISHU_INVALID_INPUT/,
  )
  const records = store.feishu.records({ id: g.id, limit: 1 })
  assert.equal(records.records[0]!.operation, 'retract')
  assert.ok(records.nextCursor)
  assert.equal(store.feishu.records({ id: other.id }).records.length, 0)
  assert.equal(
    store.exports.build({ projectId: 'a', includeSourceText: false }).events[0]!
      .sourceStatus,
    'active',
  )
  store.feishu.revoke(g.id)
  assert.equal(
    store.exports.build({ projectId: 'a', includeSourceText: false }).events[0]!
      .sourceStatus,
    'revoked',
  )
  store.processing.setEnabled(true)
  assert.equal(store.processing.claim(now), undefined)
  assert.equal(store.feishu.records({ id: g.id }).records.length, 3)
  const reconnected = store.feishu.authorize({
    projectId: 'a',
    chatId: g.chatId,
    credentialId: credential,
    startTime: start,
    endTime: start + day,
  })
  assert.notEqual(reconnected.id, g.id)
  store.close()
  store = openStore(path)
  assert.equal(store.feishu.getCooldown(credential).notBefore, 90000)
  const fresh = store.feishu.getAuthorized(reconnected.id)
  const big = Array.from({ length: 50 }, (_, n) => ({
    ...event('1', 'big-' + n, '\u0001'.repeat(65536)),
    sourceInstanceId: fresh.id,
    role: 'assistant' as const,
  }))
  store.feishu.receiveBatch({
    id: fresh.id,
    expectedGrantVersion: fresh.grantVersion,
    expectedPollVersion: fresh.pollVersion,
    expectedPageToken: '',
    expectedWindowStart: fresh.windowStart,
    expectedWindowEnd: fresh.windowEnd,
    events: big,
    nextPageToken: '',
    nextPollAt: 0,
  })
  let cursor: string | undefined
  const seen = new Set<number>()
  do {
    const page = store.feishu.records({
      id: fresh.id,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    })
    assert.ok(page.records.length)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 1024)
    for (const row of page.records) {
      assert.equal(row.role, 'assistant')
      assert.ok(!seen.has(row.id))
      seen.add(row.id)
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(seen.size, 50)
  db.prepare(
    "DELETE FROM feishu_page_tokens WHERE source_id=? AND page_token=''",
  ).run(other.id)
  assert.throws(
    () => store.feishu.getAuthorized(other.id),
    /FEISHU_INVALID_RESPONSE/,
  )
  assert.equal(store.health().schemaVersion, 13)
  console.log('Feishu storage integration passed')
} finally {
  db.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

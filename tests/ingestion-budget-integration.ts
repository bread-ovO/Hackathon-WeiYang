import { openStore } from '@memo/storage'
import {
  createIngestionBudget,
  probeIngestionDisk,
  migrateIngestionBudget,
} from '../packages/storage/src/ingestion-budget'
import { createEventReceiver } from '../packages/storage/src/receive'
import { createSources } from '../packages/storage/src/sources'
import { createPlugins } from '../packages/storage/src/plugins'
import { createEventContexts } from '../packages/storage/src/event-context'
import { createJobQueue } from '../packages/storage/src/jobs'
import { HTTP_JSON_MANIFEST_EXAMPLE } from '../packages/plugin-host/src/manifest'
import type { SourceEvent } from '@memo/contracts'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const root = mkdtempSync(join(tmpdir(), 'bugu-ingestion-budget-')),
  path = join(root, 'budget.sqlite')
let db: Database.Database | undefined
try {
  const initial = openStore(path)
  initial.tasks.createProject('a', '虚构项目')
  initial.close()
  db = new Database(path)
  db.pragma('foreign_keys=ON')
  db.pragma('journal_mode=WAL')
  if ((db.pragma('user_version', { simple: true }) as number) < 9)
    migrateIngestionBudget(db)
  let occupied = 0,
    free = 1024 ** 3,
    unavailable = false
  const probe = () => {
    if (unavailable) throw Error('FICTIONAL_PROBE_FAILURE')
    return { databaseBytes: occupied, freeDiskBytes: free }
  }
  const budget = createIngestionBudget(db, { probe })
  const receiver = createEventReceiver(
    db,
    createEventContexts(db).record,
    budget.assertCanReceive,
  )
  const receive = (event: SourceEvent, cursor: string) =>
    budget.withBatch(() => receiver(event, cursor))
  const sources = createSources(db, receive),
    plugins = createPlugins(db, receive),
    jobs = createJobQueue(db)
  const grant = sources.authorize({
    path: join(root, 'fictional.jsonl'),
    projectId: 'a',
  })
  const event = (id: string): SourceEvent => ({
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: id,
    revision: '1',
    occurredAt: '2026-09-14T09:00:00Z',
    role: 'user',
    text: '我会提交虚构修复。',
  })
  const sourceBatch = (events: SourceEvent[], cursor: string) => {
    const current = sources.getAuthorized(grant.id)
    return budget.withBatch(() =>
      sources.receiveBatch(
        grant.id,
        current.grantVersion,
        events,
        cursor,
        current.cursor,
      ),
    )
  }
  const count = () =>
    (
      db!.prepare('SELECT count(*) AS n FROM source_events').get() as {
        n: number
      }
    ).n
  const cursor = () => sources.getAuthorized(grant.id).cursor
  assert.deepEqual(budget.getStatus().limits, {
    maxQueuedJobs: 10000,
    maxDatabaseBytes: 536870912,
    minFreeDiskBytes: 268435456,
  })
  budget.configure({ maxQueuedJobs: 1 })
  assert.throws(
    () => sourceBatch([event('one'), event('two')], 'must-rollback'),
    /INGESTION_QUEUE_LIMIT/,
  )
  assert.equal(count(), 0)
  assert.equal(cursor(), '')
  assert.equal(budget.getStatus().pendingCount, 0)
  assert.equal(sourceBatch([event('one')], 'one').inserted, 1)
  assert.equal(budget.getStatus().reason, 'queue_limit')
  assert.equal(sourceBatch([event('one')], 'duplicate').inserted, 0)
  assert.equal(cursor(), 'duplicate')
  assert.equal(count(), 1)
  assert.equal(
    sources.list().find((source) => source.id === grant.id)!.status,
    'active',
  )
  const claimed = jobs.claim()!
  assert.ok(claimed)
  assert.equal(budget.getStatus().pendingCount, 1)
  jobs.complete(claimed)
  assert.equal(budget.getStatus().paused, false)
  assert.equal(sourceBatch([event('two')], 'two').inserted, 1)
  budget.configure({
    maxQueuedJobs: 100,
    maxDatabaseBytes: 1024 ** 2,
    minFreeDiskBytes: 1024 ** 2,
  })
  const before = count()
  occupied = 1024 ** 2 - 25000
  assert.throws(
    () => sourceBatch([event('large-one'), event('large-two')], 'over-budget'),
    /INGESTION_DATABASE_LIMIT/,
  )
  assert.equal(count(), before)
  assert.equal(cursor(), 'two')
  // Reservations from a rolled-back batch are discarded; a smaller retry fits.
  assert.equal(sourceBatch([event('large-one')], 'retry').inserted, 1)
  occupied = 0
  free = 1024 ** 2 + 25000
  assert.throws(
    () => sourceBatch([event('free-one'), event('free-two')], 'low-free'),
    /INGESTION_DISK_LOW/,
  )
  assert.equal(cursor(), 'retry')
  assert.equal(count(), before + 1)
  free = 1024 ** 2 - 1
  assert.equal(budget.getStatus().reason, 'disk_low')
  // Paused status is derived without writing a pause flag, even if all config writes fail.
  db.exec(
    "CREATE TRIGGER block_limits BEFORE UPDATE ON ingestion_limits BEGIN SELECT RAISE(ABORT,'SQLITE_FULL'); END",
  )
  assert.equal(budget.getStatus().reason, 'disk_low')
  assert.throws(() => budget.configure({ maxQueuedJobs: 2 }), /SQLITE_FULL/)
  db.exec('DROP TRIGGER block_limits')
  free = 1024 ** 3
  unavailable = true
  assert.equal(budget.getStatus().reason, 'probe_unavailable')
  assert.throws(
    () => sourceBatch([event('unavailable')], 'bad'),
    /INGESTION_PROBE_UNAVAILABLE/,
  )
  assert.equal(cursor(), 'retry')
  unavailable = false
  assert.equal(sourceBatch([event('unavailable')], 'recovered').inserted, 1)
  // Plugin ingress shares the guard, rolls back the entire page, and stays active.
  const input = {
    id: HTTP_JSON_MANIFEST_EXAMPLE.id,
    projectId: 'a',
    displayName: HTTP_JSON_MANIFEST_EXAMPLE.displayName,
    version: HTTP_JSON_MANIFEST_EXAMPLE.version,
    digest: 'a'.repeat(64),
    manifest: HTTP_JSON_MANIFEST_EXAMPLE,
    grant: {
      kind: 'http-json' as const,
      domain: 'api.example.com',
      credentialId: 'fictional-reference',
    },
  }
  const installed = plugins.activate(input),
    host = plugins.get(installed.id)
  budget.configure({ maxQueuedJobs: budget.getStatus().pendingCount + 1 })
  const currentCount = count()
  const pluginBatch = () =>
    budget.withBatch(() =>
      plugins.receiveBatch({
        id: installed.id,
        grantVersion: installed.grantVersion,
        expectedCursor: '',
        cursor: 'page',
        events: [
          { ...event('plugin-one'), sourceInstanceId: host.sourceInstanceId },
          { ...event('plugin-two'), sourceInstanceId: host.sourceInstanceId },
        ],
      }),
    )
  assert.throws(pluginBatch, /INGESTION_QUEUE_LIMIT/)
  assert.equal(count(), currentCount)
  assert.equal(plugins.get(installed.id).cursor, '')
  assert.equal(plugins.get(installed.id).status, 'active')
  budget.configure({ maxQueuedJobs: 100 })
  assert.equal(pluginBatch().inserted, 2)
  for (const patch of [
    {},
    { maxQueuedJobs: 0 },
    { maxQueuedJobs: 100001 },
    { maxDatabaseBytes: 100 },
    { minFreeDiskBytes: -1 },
    { unknown: 1 },
  ])
    assert.throws(
      () => budget.configure(patch as never),
      /INVALID_INGESTION_CONFIG/,
    )
  // Real stat/statfs run only against this test's isolated database and WAL.
  const real = probeIngestionDisk(path)
  const wal = (() => {
    try {
      return lstatSync(`${path}-wal`).size
    } catch {
      return 0
    }
  })()
  assert.equal(real.databaseBytes, lstatSync(path).size + wal)
  assert.ok(Number.isSafeInteger(real.freeDiskBytes) && real.freeDiskBytes >= 0)
  assert.throws(
    () => probeIngestionDisk(join(root, 'missing.sqlite')),
    /INGESTION_PROBE_UNAVAILABLE/,
  )
  symlinkSync(path, join(root, 'linked.sqlite'))
  assert.throws(
    () => probeIngestionDisk(join(root, 'linked.sqlite')),
    /INGESTION_PROBE_UNAVAILABLE/,
  )
  db.close()
  db = new Database(path)
  assert.equal(
    createIngestionBudget(db, { probe }).getStatus().limits.maxQueuedJobs,
    100,
  )
  assert.equal(db.pragma('user_version', { simple: true }), 16)
  // Exercise production openStore wrappers too, not only the injected assembly.
  const production = openStore(join(root, 'production.sqlite'))
  try {
    production.tasks.createProject('p', '真实入口虚构项目')
    const source = production.sources.authorize({
      path: join(root, 'production.jsonl'),
      projectId: 'p',
    })
    production.ingestion.configure({
      maxQueuedJobs: 1,
      maxDatabaseBytes: 8 * 1024 ** 3,
      minFreeDiskBytes: 1024 ** 2,
    })
    const values = [
      { ...event('production-one'), sourceInstanceId: source.id },
      { ...event('production-two'), sourceInstanceId: source.id },
    ]
    assert.throws(
      () =>
        production.sources.receiveBatch(
          source.id,
          source.grantVersion,
          values,
          'two',
          '',
        ),
      /INGESTION_QUEUE_LIMIT/,
    )
    assert.equal(production.health().eventCount, 0)
    assert.equal(production.sources.getAuthorized(source.id).cursor, '')
    production.ingestion.configure({
      maxQueuedJobs: 100,
      maxDatabaseBytes: 1024 ** 2,
    })
    const large = Array.from({ length: 8 }, (_, i) => ({
      ...event(`large-production-${i}`),
      sourceInstanceId: source.id,
      text: 'x'.repeat(65536),
    }))
    assert.throws(
      () =>
        production.sources.receiveBatch(
          source.id,
          source.grantVersion,
          large,
          'large',
          '',
        ),
      /INGESTION_DATABASE_LIMIT/,
    )
    assert.equal(production.health().eventCount, 0)
    assert.equal(production.sources.getAuthorized(source.id).cursor, '')
    production.ingestion.configure({
      maxDatabaseBytes: 8 * 1024 ** 3,
      maxQueuedJobs: 1,
    })
    assert.equal(
      production.sources.receiveBatch(
        source.id,
        source.grantVersion,
        [values[0]!],
        'one',
        '',
      ).inserted,
      1,
    )
    assert.equal(
      production.sources.receiveBatch(
        source.id,
        source.grantVersion,
        [values[0]!],
        'same',
        'one',
      ).inserted,
      0,
    )
    production.registerSource('base')
    assert.throws(
      () =>
        production.receive(
          { ...event('base'), sourceInstanceId: 'base' },
          'base',
        ),
      /INGESTION_QUEUE_LIMIT/,
    )
    assert.equal(production.cursor('base'), '')
  } finally {
    production.close()
  }
  // Real SQLITE_FULL using SQLite's connection-local max_page_count, without
  // filling the host disk or replacing SQLITE_FULL with a trigger string.
  const fullPath = join(root, 'full.sqlite')
  const fullStore = openStore(fullPath)
  fullStore.tasks.createProject('p', '受限数据库')
  fullStore.close()
  const full = new Database(fullPath)
  try {
    full.pragma('foreign_keys=ON')
    full.pragma('journal_mode=WAL')
    const fullBudget = createIngestionBudget(full, {
      probe: () => ({ databaseBytes: 0, freeDiskBytes: 1024 ** 3 }),
    })
    const fullReceiver = createEventReceiver(
      full,
      createEventContexts(full).record,
      fullBudget.assertCanReceive,
    )
    const fullSources = createSources(full, (e, c) =>
      fullBudget.withBatch(() => fullReceiver(e, c)),
    )
    const chosen = fullSources.authorize({
      path: join(root, 'full.jsonl'),
      projectId: 'p',
    })
    const fullEvent = {
      ...event('real-full'),
      sourceInstanceId: chosen.id,
      text: 'x'.repeat(65536),
    }
    const pages = full.pragma('page_count', { simple: true }) as number
    full.pragma(`max_page_count=${pages}`)
    // Confirm actual engine error code before testing the mapped public boundary.
    let code: unknown
    try {
      fullReceiver(fullEvent, 'must-not-advance')
    } catch (error) {
      code = (error as { code?: unknown }).code
    }
    assert.equal(code, 'SQLITE_FULL')
    assert.equal(fullSources.getAuthorized(chosen.id).cursor, '')
    assert.throws(
      () =>
        fullBudget.withBatch(() =>
          fullSources.receiveBatch(
            chosen.id,
            chosen.grantVersion,
            [fullEvent],
            'full',
            '',
          ),
        ),
      (error) =>
        error instanceof Error && error.message === 'INGESTION_DISK_LOW',
    )
    assert.equal(
      (
        full.prepare('SELECT count(*) AS n FROM source_events').get() as {
          n: number
        }
      ).n,
      0,
    )
    assert.equal(
      (full.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n,
      0,
    )
    assert.equal(fullSources.getAuthorized(chosen.id).cursor, '')
    assert.equal(fullSources.list()[0]!.status, 'active')
    full.pragma(`max_page_count=${pages + 512}`)
    assert.equal(
      fullBudget.withBatch(() =>
        fullSources.receiveBatch(
          chosen.id,
          chosen.grantVersion,
          [fullEvent],
          'recovered',
          '',
        ),
      ).inserted,
      1,
    )
    assert.equal(fullSources.getAuthorized(chosen.id).cursor, 'recovered')
  } finally {
    full.close()
  }
  console.log(
    'Ingestion budget integration passed: atomic queue/disk backpressure, duplicates, rollback, recovery, real stat/statfs and persisted limits',
  )
} finally {
  db?.close()
  rmSync(root, { recursive: true, force: true })
}

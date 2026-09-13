import assert from 'node:assert/strict'
import { runHardening } from './hardening'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { openStore as openProductionStore } from '@memo/storage'
import { migrateSearch } from '../../packages/storage/src/search'
import { openFoundationStore as openStore, type FoundationStore as Store, type StoreOptions } from '@memo/storage/foundation'
import { JobRunner, ingestNextPage } from '@memo/application'
import {
  setup,
  event,
  page,
  receive,
  proposal,
  createCommands,
  jobProposal,
  NOW,
  probe,
} from './fixtures'

const results: { name: string; ms: number }[] = []
export interface Env {
  path: string
  create: (options?: StoreOptions) => Store
  open: (options?: StoreOptions) => Store
  sql: <T>(query: string, ...params: unknown[]) => T
  crash: (mode: string, point: string, time?: number) => void
}
async function test(
  name: string,
  run: (env: Env) => void | Promise<void>,
): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'bugu-data-')),
    path = join(folder, 'test.sqlite'),
    stores: Store[] = []
  const start = performance.now()
  const env: Env = {
    path,
    create: (options = {}) => {
      const s = setup(path, options)
      stores.push(s)
      return s
    },
    open: (options = {}) => {
      const s = openStore(path, { now: () => NOW, probe, ...options })
      stores.push(s)
      return s
    },
    sql: <T>(query: string, ...params: unknown[]) => {
      const db = new Database(path)
      try {
        return db.prepare(query).get(...params) as T
      } finally {
        db.close()
      }
    },
    crash: (mode, point, time = NOW) => {
      const r = spawnSync(
        process.execPath,
        [
          resolve('apps/desktop/out/data-crash.cjs'),
          path,
          mode,
          point,
          String(time),
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          encoding: 'utf8',
          timeout: 15000,
        },
      )
      assert.equal(r.signal, 'SIGKILL', r.stderr)
      assert.match(r.stdout, /TEST_CRASH_BARRIER/)
    },
  }
  try {
    await run(env)
    results.push({ name, ms: Math.round(performance.now() - start) })
    console.log('PASS', name)
  } finally {
    for (const s of stores) {
      try {
        s.close()
      } catch {}
    }
    rmSync(folder, { recursive: true, force: true })
  }
}
const context = { sourceInstanceId: 'source', scopeEpoch: 2 }
const count = (env: Env, table: string) =>
  env.sql<{ n: number }>('SELECT count(*) AS n FROM ' + table).n

function seedLegacy(path: string): void {
  const db = new Database(path)
  db.exec(`CREATE TABLE source_instances(id TEXT PRIMARY KEY,cursor TEXT NOT NULL DEFAULT '');
    CREATE TABLE source_events(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL REFERENCES source_instances(id),external_id TEXT NOT NULL,revision TEXT NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,UNIQUE(source_id,external_id,revision));
    CREATE TABLE jobs(id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL UNIQUE REFERENCES source_events(id),state TEXT NOT NULL DEFAULT 'pending',attempt INTEGER NOT NULL DEFAULT 0,lease_until TEXT,next_run TEXT,error_code TEXT);
    CREATE INDEX jobs_pending ON jobs(state,next_run);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL,evidence_status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,archived_at TEXT);
    PRAGMA user_version=1;
    INSERT INTO source_instances VALUES('legacy-source','old-cursor');
    INSERT INTO tasks VALUES('legacy-task','旧事项','completed','sufficient',7,'2026-09-01T00:00:00Z');`)
  for (let i = 1; i <= 3; i++) {
    db.prepare('INSERT INTO source_events VALUES(?,?,?,?,?,?,?,?)').run(
      i,
      'legacy-source',
      'old-' + i,
      'rev',
      new Date(NOW).toISOString(),
      new Date(NOW).toISOString(),
      'user',
      '历史合成样例',
    )
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)').run(
      i,
      i,
      ['pending', 'done', 'failed'][i - 1],
      2,
      null,
      null,
      null,
    )
  }
  db.close()
}

async function main(): Promise<void> {
  await test('merge: production refuses foundation v2 without changing data', env => {
    const store = env.create()
    receive(store, [event()])
    store.close()
    const before = readFileSync(env.path)
    assert.throws(() => openProductionStore(env.path), /INCOMPATIBLE_DATABASE_FORMAT/)
    assert.deepEqual(readFileSync(env.path), before)
    assert.equal(env.open().health().eventCount, 1)
  })
  await test('merge: foundation refuses production v18 without changing data', env => {
    const store = openProductionStore(env.path)
    store.close()
    const before = readFileSync(env.path)
    assert.throws(() => env.open(), /DATABASE_TOO_NEW/)
    assert.deepEqual(readFileSync(env.path), before)
    const reopened = openProductionStore(env.path)
    assert.equal(reopened.health().schemaVersion, 18)
    reopened.close()
  })
  await test('merge: production v2 is distinguishable and still upgrades to v18', env => {
    seedLegacy(env.path)
    const db = new Database(env.path)
    migrateSearch(db)
    db.close()
    const before = readFileSync(env.path)
    assert.throws(() => env.open(), /INCOMPATIBLE_DATABASE_FORMAT/)
    assert.deepEqual(readFileSync(env.path), before)
    const upgraded = openProductionStore(env.path)
    assert.equal(upgraded.health().schemaVersion, 18)
    upgraded.close()
  })
  await test('S03/S04: whole-page atomicity, stable receipts and conflict detection', (env) => {
    let fail = '',
      occurrence = 0,
      nth = 1
    const s = env.create({
      fault: (p) => {
        if (p === fail && ++occurrence === nth) throw new Error('INJECTED')
      },
    })
    const p = page(s, [event(1, 'a'), event(1, 'b'), event(1, 'c')])
    for (const phase of [
      'receive:event',
      'receive:job',
      'receive:cursor',
      'receive:receipt',
    ])
      for (const n of phase === 'receive:event' ? [1, 2, 3] : [1]) {
        fail = phase
        occurrence = 0
        nth = n
        assert.throws(() => s.receivePage(p, context), /INJECTED/)
        assert.equal(count(env, 'source_events'), 0)
        assert.equal(count(env, 'jobs'), 0)
        assert.equal(count(env, 'receipts'), 0)
        assert.equal(s.checkpoint('source', 'main').version, 0)
      }
    fail = ''
    const first = s.receivePage(p, context)
    for (let i = 0; i < 10; i++)
      assert.deepEqual(s.receivePage(p, context), first)
    assert.equal(count(env, 'source_events'), 3)
    assert.equal(count(env, 'jobs'), 3)
    receive(s, [], 'empty')
    const cp = s.checkpoint('source', 'main')
    assert.equal(s.receivePage(p, context).committedVersion, 1)
    assert.deepEqual(s.checkpoint('source', 'main'), cp)
    assert.throws(
      () => s.receivePage({ ...p, nextCursor: 'different' }, context),
      /BATCH_CONTENT_CONFLICT/,
    )
    assert.throws(
      () => s.receivePage({ ...p, batchId: 'stale' }, context),
      /STALE_CHECKPOINT/,
    )
    const changed = page(
      s,
      [
        {
          ...event(1, 'a'),
          payload: { kind: 'message', role: 'user', text: 'changed' },
        },
      ],
      'conflict',
    )
    assert.throws(
      () => s.receivePage(changed, context),
      /REVISION_CONTENT_CONFLICT/,
    )
    assert.deepEqual(s.checkpoint('source', 'main'), cp)
    assert.equal(count(env, 'source_events'), 3)
    // A committed ACK is still valid while a subsequent, conflicting page is paused.
    assert.equal(s.receivePage(p, context).committedVersion, 1)
  })

  await test('S03: independent streams, stale CAS, input scope and revoked in-flight pages', async (env) => {
    const s = env.create()
    s.registerStream('source', 'second', 'scope')
    const a = page(s, [event(1, 'a')], 'a'),
      b = { ...page(s, [event(1, 'b')], 'b') }
    s.receivePage(a, context)
    assert.throws(() => s.receivePage(b, context), /STALE_CHECKPOINT/)
    assert.equal(s.checkpoint('source', 'second').version, 0)
    const second = {
      ...page(s, [event(1, 'a')], 'overlap'),
      streamId: 'second',
      expectedCursorVersion: 0,
    }
    s.receivePage(second, context)
    assert.equal(count(env, 'source_events'), 1)
    assert.throws(
      () =>
        receive(s, [{ ...event(1, 'evil'), sourceInstanceId: 'other' }], 'bad'),
      /SCOPE_DENIED/,
    )
    let finish!: (value: unknown) => void
    const promise = ingestNextPage(
      s,
      {
        pull: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      },
      context,
      'main',
      'in-flight',
      new AbortController().signal,
    )
    s.revokeSource('source')
    finish({ events: [event(1, 'late')], nextCursor: 'late' })
    await assert.rejects(promise, /SOURCE_DISABLED|STALE_AUTHORIZATION/)
    assert.equal(count(env, 'source_events'), 1)
    assert.equal(s.checkpoint('source', 'main').version, 1)
  })

  await test('S01/S04/S07: equivalent facts, A-B-A revisions and tombstone ordering', (env) => {
    const s = env.create()
    const e = event()
    receive(s, [e])
    const equiv = {
      ...e,
      occurredAt: '2026-09-12T17:00:01+08:00',
      sourceUpdatedAt: '2026-09-12T17:00:01+08:00',
      timeBasis: { ...e.timeBasis, raw: '2026-09-12T17:00:01+08:00' },
      provenance: { ...e.provenance, adapterVersion: '2' },
    }
    receive(s, [equiv], 'equiv')
    assert.equal(count(env, 'source_events'), 1)
    receive(
      s,
      [event(2, 'message', 'B'), event(3, 'message', '提交修复 PR 并反馈链接')],
      'edits',
    )
    assert.equal(count(env, 'source_events'), 3)
    const tomb = {
      ...event(5),
      eventType: 'retracted' as const,
      payload: { kind: 'tombstone' as const },
    }
    receive(s, [tomb], 'dead')
    const generation = s.eventGeneration(1)
    receive(s, [event(4, 'message', '迟到旧正文')], 'late')
    assert.equal(s.eventGeneration(1), generation)
    assert.equal(
      env.sql<{ state: string }>('SELECT state FROM source_object_heads').state,
      'tombstone',
    )
  })

  await test('S03: process kill during page transaction and after durable commit', (env) => {
    const s = env.create()
    env.crash('page', 'receive:cursor')
    assert.equal(count(env, 'source_events'), 0)
    assert.equal(count(env, 'receipts'), 0)
    env.crash('page', 'receive:after_commit')
    assert.equal(count(env, 'source_events'), 2)
    assert.equal(count(env, 'receipts'), 1)
    const retry = {
      ...page(s, [event(1, 'crash-a'), event(1, 'crash-b')], 'crash-batch'),
      expectedCursorVersion: 0,
    }
    assert.equal(s.receivePage(retry, context).inserted, 2)
    assert.equal(s.checkpoint('source', 'main').version, 1)
  })

  await test('S02: four dimensions, criterion references, manual protection and rollback', (env) => {
    const s = env.create({ allowAutoComplete: true })
    receive(s, [event(1, 'pr'), event(1, 'feedback')])
    s.submitManual('create', proposal(s, createCommands()))
    s.submitManual(
      'conditions',
      proposal(
        s,
        [
          {
            kind: 'set_criteria',
            taskId: 'task',
            criteria: [
              { id: 'pr', description: '提交 PR', originEventId: 1 },
              { id: 'reply', description: '反馈链接', originEventId: 2 },
            ],
          },
        ],
        [1, 2],
      ),
    )
    const t = s.getTask('task')!
    assert.equal(t.criteriaVersion, 1)
    assert.throws(
      () =>
        s.submitManual(
          'invalid-ref',
          proposal(
            s,
            [
              {
                kind: 'add_evidence',
                taskId: 'task',
                links: [
                  {
                    criterionId: 'missing',
                    criteriaVersion: 1,
                    eventId: 1,
                    relation: 'support',
                    start: 0,
                    end: 2,
                  },
                ],
              },
            ],
            [1],
          ),
        ),
      /FOREIGN KEY/,
    )
    assert.equal(s.getTask('task')!.version, t.version)
    assert.equal(count(env, 'evidence_links'), 0)
    s.submitManual(
      'manual-done',
      proposal(s, [
        { kind: 'set_status', taskId: 'task', status: 'completed' },
      ]),
    )
    assert.equal(s.getTask('task')!.evidenceStatus, 'unknown')
    const lease = s.claimJob('worker', ['v1'])!,
      old = jobProposal(s, lease, [
        { kind: 'set_status', taskId: 'task', status: 'waiting' },
      ])
    assert.throws(() => s.commitJob(lease, old), /MANUAL_OVERRIDE/)
    s.submitManual(
      'archive',
      proposal(s, [
        {
          kind: 'archive',
          taskId: 'task',
          archivedAt: new Date(NOW).toISOString(),
        },
      ]),
    )
    assert.equal(s.getTask('task')!.status, 'completed')
    assert.equal(s.getTask('task')!.evidenceStatus, 'unknown')
    assert.throws(() => s.commitJob(lease, old), /VERSION_CONFLICT/)
    s.submitManual(
      'ignore',
      proposal(s, [{ kind: 'set_intake', taskId: 'task', intake: 'ignored' }]),
    )
    assert.equal(s.getTask('task')!.status, 'completed')
  })

  await test('S02/V05 substrate: sufficient evidence, criteria revision and source withdrawal', (env) => {
    const s = env.create({ allowAutoComplete: true })
    receive(s, [event(1, 'pr'), event(1, 'feedback')])
    s.submitManual('create', proposal(s, createCommands()))
    s.submitManual(
      'conditions',
      proposal(
        s,
        [
          {
            kind: 'set_criteria',
            taskId: 'task',
            criteria: [{ id: 'pr', description: '提交 PR', originEventId: 1 }],
          },
        ],
        [1],
      ),
    )
    s.submitManual(
      'evidence',
      proposal(
        s,
        [
          {
            kind: 'add_evidence',
            taskId: 'task',
            links: [
              {
                criterionId: 'pr',
                criteriaVersion: 1,
                eventId: 1,
                relation: 'support',
                start: 0,
                end: 2,
              },
            ],
          },
        ],
        [1],
      ),
    )
    assert.equal(s.getTask('task')!.evidenceStatus, 'sufficient')
    const lease = s.claimJob('worker', ['v1'])!
    s.commitJob(
      lease,
      jobProposal(s, lease, [
        { kind: 'set_status', taskId: 'task', status: 'completed' },
      ]),
    )
    assert.equal(s.getTask('task')!.status, 'completed')
    s.submitManual(
      'new-conditions',
      proposal(
        s,
        [
          {
            kind: 'set_criteria',
            taskId: 'task',
            criteria: [
              { id: 'pr', description: '提交 PR', originEventId: 1 },
              { id: 'reply', description: '反馈', originEventId: 2 },
            ],
          },
        ],
        [1, 2],
      ),
    )
    assert.equal(s.getTask('task')!.evidenceStatus, 'unknown')
    assert.equal(count(env, 'evidence_links'), 1)
    const oldGeneration = s.eventGeneration(1)
    receive(
      s,
      [
        {
          ...event(2, 'pr'),
          eventType: 'retracted',
          payload: { kind: 'tombstone' },
        },
      ],
      'withdraw',
    )
    assert.ok(s.eventGeneration(1) > oldGeneration)
    assert.equal(
      env.sql<{ validity: string }>('SELECT validity FROM evidence_links')
        .validity,
      'invalid',
    )
  })

  await test('S05: atomic claim, fencing, expired lease and crash budget', (env) => {
    let now = NOW
    const s = env.create({ now: () => now })
    receive(s, [event()])
    const a = s.claimJob('a', ['v1'], 100)!
    assert.equal(s.claimJob('b', ['v1'], 100), null)
    s.renewLease(a, 100)
    assert.equal(s.job(a.id).attempt, 1)
    now += 101
    const b = s.claimJob('b', ['v1'], 100)!
    assert.ok(b.token > a.token)
    for (const op of [
      () => s.renewLease(a),
      () => s.failJob(a, 'LATE', 'retry'),
      () => s.saveProposal(a, jobProposal(s, a, [])),
      () => s.commitJob(a, jobProposal(s, a, [])),
    ])
      assert.throws(op, /STALE_LEASE/)
    s.failJob(b, 'TRANSIENT', 'retry', 50)
    assert.equal(s.claimJob('c', ['v1'], 100), null)
    now += 51
    const c = s.claimJob('c', ['v1'], 100)!
    s.failJob(c, 'PERMANENT', 'dead')
    assert.equal(s.job(c.id).state, 'dead')
  })

  await test('S05: repeated real process crashes stop at maxAttempts', (env) => {
    const s = env.create()
    receive(s, [event()])
    const raw = new Database(env.path)
    raw.exec('UPDATE jobs SET max_attempts=3')
    raw.close()
    for (let i = 0; i < 3; i++) env.crash('claim', 'after-claim', NOW + i * 101)
    const later = env.open({ now: () => NOW + 304 })
    assert.equal(later.claimJob('fourth', ['v1'], 100), null)
    assert.equal(s.job(1).state, 'dead')
    assert.equal(s.job(1).attempt, 3)
  })

  await test('S04/S05: business and job completion survive transaction and post-commit kills', (env) => {
    const s = env.create()
    receive(s, [event()])
    env.crash('job', 'job:business_written')
    assert.equal(count(env, 'tasks'), 0)
    assert.equal(count(env, 'operation_commits'), 0)
    env.crash('job', 'job:after_commit', NOW + 101)
    assert.equal(count(env, 'tasks'), 1)
    assert.equal(count(env, 'decisions'), 1)
    assert.equal(count(env, 'task_revisions'), 1)
    assert.equal(count(env, 'notification_outbox'), 1)
    assert.equal(s.job(1).state, 'done')
    assert.equal(s.getTask('task')!.version, 1)
    const p = {
      ...page(s, [event()], 'repeat'),
      expectedCursorVersion: s.checkpoint('source', 'main').version,
    }
    for (let i = 0; i < 10; i++) s.receivePage(p, context)
    assert.equal(count(env, 'tasks'), 1)
    assert.equal(count(env, 'jobs'), 1)
  })

  await test('S05 runner: real handler commit, validated output, timeout and no handler', async (env) => {
    const s = env.create()
    receive(s, [event()])
    const runner = new JobRunner(
      s,
      new Map([['v1', async ({ lease }) => jobProposal(s, lease)]]),
      { owner: 'runner', leaseMs: 100, timeoutMs: 200, random: () => 0 },
    )
    assert.equal(await runner.runOnce(), true)
    assert.equal(s.job(1).state, 'done')
    assert.equal(s.getTask('task')!.intake, 'accepted')
    receive(s, [event(1, 'invalid')], 'invalid')
    const invalid = new JobRunner(
      s,
      new Map([['v1', async () => ({ execute: 'bad' })]]),
      { owner: 'invalid' },
    )
    await invalid.runOnce()
    assert.equal(s.job(2).state, 'dead')
    receive(s, [event(1, 'timeout')], 'timeout')
    const timeout = new JobRunner(
      s,
      new Map([['v1', async () => new Promise<never>(() => {})]]),
      { owner: 'timeout', leaseMs: 100, timeoutMs: 20 },
    )
    await timeout.runOnce()
    assert.equal(s.job(3).state, 'retry_wait')
    const absent = new JobRunner(s, new Map(), { owner: 'absent' })
    assert.equal(await absent.runOnce(), false)
    assert.ok(s.health().pauses.some((p) => p.code === 'NO_HANDLER'))
  })

  await test('S07: mapping versions and late plan facts cannot override a newer plan', (env) => {
    const s = env.create()
    receive(s, [event(1, 'old'), event(2, 'new')])
    s.submitManual('create', proposal(s, createCommands()))
    const one = s.registerIdentity('source', 'person', 'one', '同名'),
      two = s.registerIdentity('source', 'person', 'two', '同名')
    assert.notEqual(one, two)
    s.confirmMapping('mapping', one, two, 'project', 'user')
    const lease = s.claimJob('worker', ['v1'])!
    const mapped = jobProposal(s, lease, [
      { kind: 'set_status', taskId: 'task', status: 'waiting' },
    ])
    mapped.mappings = [{ id: 'mapping', version: 1 }]
    s.revokeMapping('mapping', 1, 'user')
    assert.throws(() => s.commitJob(lease, mapped), /STALE_MAPPING/)
    s.failJob(lease, 'STALE_MAPPING', 'dead')
    const newer = s.claimJob('next', ['v1'])!
    const plan = jobProposal(s, newer, [
      {
        kind: 'set_due',
        taskId: 'task',
        dueAt: '2026-09-20T00:00:00Z',
        effectiveAt: event(2, 'new').occurredAt!,
        originEventId: 2,
      },
    ])
    s.commitJob(newer, plan)
    const rerun = s.reprocessEvent(1, 'v1')
    const late = s.claimJob('late', ['v1'])!
    assert.equal(late.id, rerun)
    assert.throws(
      () =>
        s.commitJob(
          late,
          jobProposal(s, late, [
            {
              kind: 'set_due',
              taskId: 'task',
              dueAt: '2026-09-15T00:00:00Z',
              effectiveAt: event(1, 'old').occurredAt!,
              originEventId: 1,
            },
          ]),
        ),
      /STALE_PLAN/,
    )
    assert.equal(s.getTask('task')!.dueAt, '2026-09-20T00:00:00Z')
  })

  await test('S08: UTF-8 budgets, duplicate receipts, queue hysteresis and persistent pause', (env) => {
    const s = env.create({ limits: { queueHigh: 2, queueLow: 1 } })
    const p = page(s, [event(1, 'one'), event(1, 'two')])
    s.receivePage(p, context)
    assert.throws(() => receive(s, [event(1, 'three')], 'full'), /QUEUE_LIMIT/)
    assert.equal(s.receivePage(p, context).inserted, 2)
    const lease = s.claimJob('worker', ['v1'])!
    s.commitJob(lease, jobProposal(s, lease, []))
    receive(s, [event(1, 'three')], 'resume')
    assert.equal(count(env, 'source_events'), 3)
    const e = event(1, 'oversize', '中😀'),
      size = Buffer.byteLength(JSON.stringify(e))
    s.setLimits({ eventBytes: size - 1, queueHigh: 100, queueLow: 50 })
    assert.throws(() => receive(s, [e], 'big'), /EVENT_TOO_LARGE/)
    const version = s.checkpoint('source', 'main').version
    s.close()
    const again = env.open()
    assert.ok(again.health().pauses.some((p) => p.code === 'EVENT_TOO_LARGE'))
    again.setLimits({ eventBytes: size })
    again.resumeSource('source')
    receive(again, [e], 'big')
    assert.equal(again.checkpoint('source', 'main').version, version + 1)
  })

  await test('S08: unavailable disk, automatic result admission, actual SQLITE_FULL and recovery', (env) => {
    let available = 1024 * 1024 * 1024
    const s = env.create({
      probe: () => ({ usedBytes: 1024 * 1024, availableBytes: available }),
    })
    receive(s, [event()])
    const lease = s.claimJob('worker', ['v1'])!,
      p = jobProposal(s, lease)
    available = 0
    assert.throws(() => s.commitJob(lease, p), /DISK_LIMIT/)
    assert.equal(count(env, 'tasks'), 0)
    assert.equal(s.job(1).state, 'running')
    available = 1024 * 1024 * 1024
    s.commitJob(lease, p)
    s.close()
    const raw = new Database(env.path),
      pages = raw.pragma('page_count', { simple: true }) as number
    raw.close()
    const limited = env.open({ sqlitePageLimit: pages + 1 })
    const before = limited.checkpoint('source', 'main')
    assert.throws(
      () => receive(limited, [event(1, 'large', '中'.repeat(50000))], 'full'),
      /full/i,
    )
    assert.deepEqual(limited.checkpoint('source', 'main'), before)
    assert.equal(count(env, 'source_events'), 1)
    limited.close()
    const restored = env.open()
    receive(restored, [event(1, 'large', '中'.repeat(50000))], 'full')
    assert.equal(count(env, 'source_events'), 2)
  })

  await test('S08: WAL growth is measured and checkpoint reports a long reader', (env) => {
    const s = env.create({ probe: undefined })
    receive(s, [event()])
    const before = s.health().resources.usedBytes,
      reader = new Database(env.path)
    reader.exec('BEGIN')
    reader.prepare('SELECT * FROM source_events').all()
    try {
      for (let i = 0; i < 8; i++)
        receive(s, [event(1, 'wal-' + i, '内容'.repeat(1000))], 'wal-' + i)
      assert.ok(s.health().resources.usedBytes > before)
      const check = s.checkpointWal()
      assert.ok(check.logPages > check.checkpointedPages)
    } finally {
      reader.exec('ROLLBACK')
      reader.close()
    }
    const check = s.checkpointWal()
    assert.equal(check.logPages, check.checkpointedPages)
  })

  await test('S02: v1 consistent backup, conservative migration and repeated open', (env) => {
    seedLegacy(env.path)
    const s = env.open()
    assert.equal(s.health().schemaVersion, 2)
    assert.equal(count(env, 'source_events'), 3)
    assert.equal(s.cursor('legacy-source'), 'old-cursor')
    assert.deepEqual(
      [s.job(1).state, s.job(2).state, s.job(3).state],
      ['paused', 'done', 'dead'],
    )
    assert.equal(s.job(1).attempt, 2)
    const t = s.getTask('legacy-task')!
    assert.equal(t.status, 'completed')
    assert.equal(t.evidenceStatus, 'unknown')
    assert.equal(t.intake, null)
    assert.equal(t.archivedAt, '2026-09-01T00:00:00Z')
    assert.equal(t.version, 7)
    assert.equal(t.legacy, true)
    assert.equal(count(env, 'manual_overrides'), 0)
    assert.equal(count(env, 'task_baselines'), 1)
    assert.equal(
      env.sql<{ active: number }>('SELECT active FROM source_instances').active,
      0,
    )
    assert.equal(
      JSON.parse(
        env.sql<{ snapshot: string }>('SELECT snapshot FROM task_baselines')
          .snapshot,
      ).evidence_status,
      'sufficient',
    )
    assert.equal(s.event(1).eventType, 'observed')
    assert.equal(s.event(1).provenance.author, null)
    const backups = readdirSync(env.path + '.backups')
    assert.equal(backups.length, 1)
    const saved = new Database(join(env.path + '.backups', backups[0]!), {
      readonly: true,
    })
    assert.equal(saved.pragma('user_version', { simple: true }), 1)
    assert.equal(saved.pragma('quick_check', { simple: true }), 'ok')
    saved.close()
    s.close()
    const reopened = env.open()
    assert.equal(reopened.health().schemaVersion, 2)
    assert.equal(count(env, 'task_baselines'), 1)
    assert.equal(readdirSync(env.path + '.backups').length, 1)
  })

  for (const phase of [
    'backup:before',
    'backup:after',
    'migration:before',
    'migration:copied',
    'migration:verified',
  ]) {
    await test('S02: migration fails closed at ' + phase, (env) => {
      seedLegacy(env.path)
      assert.throws(
        () =>
          env.open({
            fault: (p) => {
              if (p === phase) throw new Error('INJECTED')
            },
          }),
        /INJECTED/,
      )
      const raw = new Database(env.path)
      assert.equal(raw.pragma('user_version', { simple: true }), 1)
      assert.equal(
        (
          raw.prepare('SELECT evidence_status FROM tasks').get() as {
            evidence_status: string
          }
        ).evidence_status,
        'sufficient',
      )
      assert.equal(raw.pragma('quick_check', { simple: true }), 'ok')
      raw.close()
      const s = env.open()
      assert.equal(s.health().schemaVersion, 2)
    })
  }
  await test('S02: failed backup path and future database never start writers', (env) => {
    seedLegacy(env.path)
    writeFileSync(env.path + '.backups', 'occupied')
    assert.throws(() => env.open(), /EEXIST|ENOTDIR/)
    assert.equal(
      env.sql<{ user_version: number }>('PRAGMA user_version').user_version,
      1,
    )
    rmSync(env.path + '.backups')
    const raw = new Database(env.path)
    raw.pragma('user_version=999')
    raw.close()
    assert.throws(() => env.open(), /DATABASE_TOO_NEW/)
    assert.equal(
      env.sql<{ user_version: number }>('PRAGMA user_version').user_version,
      999,
    )
  })

  await test('S05/S08: paused work resumes with capacity, clock pause requires explicit resume', async (env) => {
    let free = 1024 * 1024 * 1024
    const s = env.create({
      probe: () => ({ usedBytes: 1024 * 1024, availableBytes: free }),
    })
    receive(s, [event()])
    const a = s.claimJob('a', ['v1'])!
    s.failJob(a, 'DISK_LIMIT', 'paused')
    free = 0
    assert.throws(() => s.claimJob('b', ['v1']), /DISK_LIMIT/)
    free = 1024 * 1024 * 1024
    const b = s.claimJob('b', ['v1'])!
    assert.equal(b.attempt, 2)
    s.failJob(b, 'CLOCK_CHANGED', 'paused')
    assert.equal(s.claimJob('c', ['v1']), null)
    s.resumeSource('source')
    const c = s.claimJob('c', ['v1'])!
    assert.equal(c.attempt, 3)
    s.commitJob(c, jobProposal(s, c, []))
    assert.equal(s.job(c.id).state, 'done')
    assert.equal(count(env, 'operation_commits'), 1)
    assert.equal(count(env, 'notification_outbox'), 0)
  })
  await test('S05: lease expires during business transaction and rolls back all writes', (env) => {
    let time = NOW,
      expire = false
    const s = env.create({
      now: () => time,
      fault: (p) => {
        if (expire && p === 'job:business_written') time += 1000
      },
    })
    receive(s, [event()])
    const lease = s.claimJob('worker', ['v1'], 100)!
    expire = true
    assert.throws(
      () => s.commitJob(lease, jobProposal(s, lease)),
      /STALE_LEASE/,
    )
    assert.equal(count(env, 'tasks'), 0)
    assert.equal(count(env, 'decisions'), 0)
    assert.equal(s.job(1).state, 'running')
  })
  await test('S03/S08: receipt retention and queue hysteresis survive restart', (env) => {
    const s = env.create({ limits: { queueHigh: 3, queueLow: 1 } })
    const old = page(s, [event(1, 'a')], 'old')
    s.receivePage(old, context)
    receive(s, [event(1, 'b'), event(1, 'c')], 'next')
    s.pruneReceipts('source', 'main', 1)
    assert.throws(() => s.receivePage(old, context), /STALE_CHECKPOINT/)
    assert.throws(() => receive(s, [event(1, 'd')], 'later'), /QUEUE_LIMIT/)
    const first = s.claimJob('worker', ['v1'])!
    s.commitJob(first, jobProposal(s, first, []))
    s.close()
    const reopened = env.open({ limits: { queueHigh: 3, queueLow: 1 } })
    assert.throws(
      () => receive(reopened, [event(1, 'd')], 'later'),
      /QUEUE_LIMIT/,
    )
    const second = reopened.claimJob('worker', ['v1'])!
    reopened.commitJob(second, jobProposal(reopened, second, []))
    receive(reopened, [event(1, 'd')], 'later')
    assert.equal(reopened.checkpoint('source', 'main').version, 3)
  })

  await test('S06: project/scope before LIMIT, consistent index, fallback and deletion', (env) => {
    let fail = false
    const s = env.create({
      fault: (p) => {
        if (fail && p === 'search:updated') throw new Error('INDEX_FAULT')
      },
    })
    s.createProject('other', '其他项目')
    for (let i = 0; i < 25; i++)
      s.submitManual(
        'other-' + i,
        proposal(s, createCommands('other-' + i, '同名登录验收', 'other')),
      )
    s.submitManual(
      'target',
      proposal(s, createCommands('target', '同名登录验收')),
    )
    const query = { projectId: 'project', sourceIds: ['source'], query: '登录' }
    assert.deepEqual(
      s.search(query).items.map((i) => i.id),
      ['target'],
    )
    assert.equal(s.search({ ...query, projectId: 'missing' }).items.length, 0)
    assert.equal(
      s.search({ ...query, sourceIds: [] }).fallback,
      'scope_unknown',
    )
    assert.equal(s.search({ ...query, query: '  ' }).fallback, 'empty_query')
    for (const text of ['" OR NEAR *', '登', 'src/core.ts'])
      assert.ok(s.search({ ...query, query: text }).items.length <= 20)
    assert.throws(
      () => s.search({ ...query, query: '中'.repeat(1500) }),
      /QUERY_TOO_LARGE/,
    )
    const before = s.getTask('target')!
    fail = true
    assert.throws(
      () =>
        s.submitManual(
          'rename-fail',
          proposal(s, [
            { kind: 'set_title', taskId: 'target', title: '结算对账' },
          ]),
        ),
      /INDEX_FAULT/,
    )
    assert.equal(s.getTask('target')!.title, before.title)
    assert.deepEqual(
      s.search(query).items.map((i) => i.id),
      ['target'],
    )
    fail = false
    s.submitManual(
      'rename',
      proposal(s, [{ kind: 'set_title', taskId: 'target', title: '结算对账' }]),
    )
    const newQuery = { ...query, query: '结算' }
    assert.equal(s.search(newQuery).fallback, null)
    s.rebuildSearch()
    assert.equal(s.search(newQuery).fallback, null)
    const raw = new Database(env.path)
    raw
      .prepare("UPDATE store_meta SET value='0' WHERE key='search_ready'")
      .run()
    raw.close()
    assert.equal(s.search(newQuery).fallback, 'index_unavailable')
    s.rebuildSearch()
    s.registerSource({
      id: 'private',
      provider: 'fixture',
      accountId: 'private',
      tenantId: null,
      revisionBasis: 'sequence',
    })
    s.grantSource('private', ['private-scope'], 1)
    s.submitManual(
      'link-private',
      proposal(s, [
        {
          kind: 'link_source',
          taskId: 'target',
          sourceId: 'private',
          scopeId: 'private-scope',
        },
      ]),
    )
    assert.equal(s.search(newQuery).items.length, 0)
    assert.equal(
      s.search({ ...newQuery, sourceIds: ['source', 'private'] }).items.length,
      1,
    )
    s.deleteTask('target', s.getTask('target')!.version, 'user')
    assert.equal(
      s.search({ ...newQuery, sourceIds: ['source', 'private'] }).items.length,
      0,
    )
    s.revokeSource('source')
    assert.throws(() => s.search(query), /SOURCE_DISABLED/)
  })

  await test('S05: stopping runner preserves retryable work and exhaustion is terminal', async (env) => {
    const s = env.create()
    receive(s, [event()])
    let started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const runner = new JobRunner(
      s,
      new Map([
        [
          'v1',
          async () => {
            started()
            return new Promise(() => {})
          },
        ],
      ]),
      { owner: 'shutdown', leaseMs: 1000 },
    )
    runner.start()
    await began
    await runner.stop()
    assert.equal(s.job(1).state, 'retry_wait')
    const raw = new Database(env.path)
    raw
      .prepare(
        "UPDATE jobs SET attempt=max_attempts,state='paused',error_code='DISK_LIMIT' WHERE id=1",
      )
      .run()
    raw.close()
    assert.equal(s.claimJob('next', ['v1']), null)
    assert.equal(s.job(1).state, 'dead')
    assert.equal(
      s.search({ projectId: null, sourceIds: ['source'], query: '登录' })
        .fallback,
      'scope_unknown',
    )
  })

  await test('S02 hardening: backup includes committed WAL with another connection open', (env) => {
    seedLegacy(env.path)
    const writer = new Database(env.path)
    try {
      writer.pragma('journal_mode=WAL')
      writer.pragma('wal_checkpoint(TRUNCATE)')
      writer
        .prepare('INSERT INTO source_events VALUES(?,?,?,?,?,?,?,?)')
        .run(
          4,
          'legacy-source',
          'wal-only',
          'rev',
          new Date(NOW).toISOString(),
          new Date(NOW).toISOString(),
          'user',
          'WAL 合成事实',
        )
      const s = env.open()
      assert.equal(s.health().eventCount, 4)
      const backup = new Database(
        join(env.path + '.backups', readdirSync(env.path + '.backups')[0]!),
        { readonly: true },
      )
      try {
        assert.equal(
          (
            backup.prepare('SELECT count(*) AS n FROM source_events').get() as {
              n: number
            }
          ).n,
          4,
        )
        assert.equal(backup.pragma('user_version', { simple: true }), 1)
      } finally {
        backup.close()
      }
    } finally {
      writer.close()
    }
  })
  await test('S02 hardening: invalid old foreign keys abort migration and preserve v1', (env) => {
    seedLegacy(env.path)
    const raw = new Database(env.path)
    raw.pragma('foreign_keys=OFF')
    raw
      .prepare("INSERT INTO jobs VALUES(4,999,'pending',0,NULL,NULL,NULL)")
      .run()
    raw.close()
    assert.throws(() => env.open(), /FOREIGN KEY/)
    assert.equal(
      env.sql<{ user_version: number }>('PRAGMA user_version').user_version,
      1,
    )
    assert.equal(count(env, 'source_events'), 3)
    assert.equal(count(env, 'jobs'), 4)
  })

  await runHardening(test)

  await test('S06: frozen 120-case recall and 10k-task cold/warm baseline', (env) => {
    const s = env.create({ limits: { diskBytes: 2 * 1024 * 1024 * 1024 } })
    const fixture = JSON.parse(
      readFileSync(resolve('tests/data-foundation/search-cases.json'), 'utf8'),
    ) as {
      version: string
      documents: { id: string; title: string }[]
      queries: { group: string; query: string; expected: string[] }[]
    }
    assert.equal(fixture.queries.length, 120)
    for (const doc of fixture.documents)
      s.submitManual(
        'seed-' + doc.id,
        proposal(s, createCommands(doc.id, doc.title)),
      )
    const misses: unknown[] = [],
      groups: Record<
        string,
        {
          positive: number
          recall: number
          negative: number
          negativeCandidates: number
        }
      > = {}
    const cases = fixture.queries.map((q) => {
      const result = s.search({
          projectId: 'project',
          sourceIds: ['source'],
          query: q.query,
        }),
        ids = result.items.map((i) => i.id)
      const rank = q.expected.length
        ? Math.min(
            ...q.expected.map((id) =>
              ids.indexOf(id) < 0 ? Infinity : ids.indexOf(id) + 1,
            ),
          )
        : null
      const recall = q.expected.length
        ? q.expected.filter((id) => ids.includes(id)).length / q.expected.length
        : null
      const g = (groups[q.group] ??= {
        positive: 0,
        recall: 0,
        negative: 0,
        negativeCandidates: 0,
      })
      if (recall !== null) {
        g.positive++
        g.recall += recall
        if (recall < 1)
          misses.push({ query: q.query, expected: q.expected, ids })
      } else {
        g.negative++
        g.negativeCandidates += ids.length
      }
      return {
        ...q,
        rank,
        recall,
        fallback: result.fallback,
        candidateCount: ids.length,
      }
    })
    const macro =
      Object.values(groups).reduce((n, g) => n + g.recall / g.positive, 0) /
      Object.keys(groups).length
    mkdirSync('test-results', { recursive: true })
    writeFileSync(
      'test-results/search-recall.json',
      JSON.stringify(
        {
          fixture: fixture.version,
          tokenizer: s.search({
            projectId: 'project',
            sourceIds: ['source'],
            query: '登录',
          }).tokenizerVersion,
          macroRecallAt20: macro,
          groups,
          misses,
          cases,
        },
        null,
        2,
      ),
    )
    assert.ok(macro >= 0.95)
    for (const g of Object.values(groups))
      assert.ok(g.recall / g.positive >= 0.9)
    assert.equal(misses.length, 0)
    const start = performance.now()
    for (let i = fixture.documents.length; i < 10000; i++)
      s.submitManual(
        'seed-' + i,
        proposal(
          s,
          createCommands(
            'scale-' + i,
            '合成事项组件 component_' + i + ' 构建验证',
          ),
        ),
      )
    const seedMs = performance.now() - start,
      rebuildStart = performance.now()
    s.rebuildSearch()
    const rebuildMs = performance.now() - rebuildStart
    s.close()
    const reopened = env.open(),
      times: number[] = []
    for (let i = 0; i < 60; i++) {
      const start = performance.now()
      reopened.search({
        projectId: 'project',
        sourceIds: ['source'],
        query: i % 2 ? 'component_9876' : '登录',
      })
      times.push(performance.now() - start)
    }
    const warm = times.slice(2).sort((a, b) => a - b)
    const stats = env.sql<{ bytes: number }>(
      'SELECT sum(pgsize) AS bytes FROM dbstat',
    )
    writeFileSync(
      'test-results/search-performance.json',
      JSON.stringify(
        {
          tasks: 10000,
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          electron: process.versions.electron,
          sqlite: reopened.health().sqliteVersion,
          coldMs: times[0],
          p50Ms: warm[Math.floor(warm.length * 0.5)],
          p95Ms: warm[Math.floor(warm.length * 0.95)],
          seedMs,
          rebuildMs,
          databaseBytes: stats.bytes,
          threshold: 'baseline only; performance budget not yet frozen',
        },
        null,
        2,
      ),
    )
  })

  mkdirSync('test-results', { recursive: true })
  writeFileSync(
    'test-results/data-foundation.json',
    JSON.stringify(
      {
        scope:
          'synthetic SQLite integration; no real source/model authorization claimed',
        results,
      },
      null,
      2,
    ),
  )
  console.log(
    'Data foundation integration passed:',
    results.length,
    'scenarios',
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

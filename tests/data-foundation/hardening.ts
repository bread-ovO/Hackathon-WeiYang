import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { JobRunner, type JobHandler } from '@memo/application'
import type { DecisionProposal } from '@memo/contracts'
import type { Env } from './integration'
import {
  event,
  receive,
  page,
  proposal,
  createCommands,
  jobProposal,
  NOW,
} from './fixtures'

type Test = (
  name: string,
  run: (env: Env) => void | Promise<void>,
) => Promise<void>
const count = (env: Env, table: string) =>
  env.sql<{ n: number }>('SELECT count(*) AS n FROM ' + table).n
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function raceWorkers(path: string, mode: 'claim' | 'page') {
  const children: ChildProcess[] = []
  type Result = { ok: boolean; code?: string; value?: unknown }
  try {
    const contenders = Array.from({ length: 4 }, (_, i) => {
      const ready = deferred<void>(),
        result = deferred<Result>(),
        closed = deferred<void>()
      const child = spawn(
        process.execPath,
        [resolve('apps/desktop/out/data-race.cjs'), path, mode, 'worker-' + i],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      )
      children.push(child)
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += chunk
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
      const completion = new Promise<Result>((resolve, reject) => {
        let received = false
        child.on('message', (message: unknown) => {
          const m = message as { type: string } & Result
          if (m.type === 'ready') ready.resolve()
          if (m.type === 'result') {
            received = true
            result.resolve(m)
          }
        })
        child.once('error', reject)
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          closed.resolve()
          if (code !== 0 || signal || !received)
            reject(new Error('RACE_WORKER_FAILED: ' + stderr))
          else void result.promise.then(resolve)
        })
      })
      // An early child failure must break both barriers without an unhandled rejection.
      return {
        ready: Promise.race([ready.promise, completion.then(() => {})]),
        completion,
        closed: closed.promise,
        child,
      }
    })
    const completions = Promise.all(contenders.map((c) => c.completion))
    void completions.catch(() => {})
    await Promise.all(contenders.map((c) => c.ready))
    for (const contender of contenders) contender.child.send('go')
    return await completions
  } finally {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve()
              return
            }
            child.once('exit', () => resolve())
            child.kill('SIGKILL')
          }),
      ),
    )
  }
}

export async function runHardening(test: Test): Promise<void> {
  await test('S03 hardening: four independent processes contend for one checkpoint', async (env) => {
    const s = env.create()
    const results = await raceWorkers(env.path, 'page')
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.deepEqual(
      results.filter((r) => !r.ok).map((r) => r.code),
      Array(3).fill('STALE_CHECKPOINT'),
    )
    assert.equal(s.checkpoint('source', 'main').version, 1)
    for (const table of ['source_events', 'jobs', 'receipts'])
      assert.equal(count(env, table), 1)
  })
  await test('S05 hardening: four independent processes cannot share a lease', async (env) => {
    const s = env.create()
    receive(s, [event()])
    const results = await raceWorkers(env.path, 'claim')
    assert.ok(results.every((r) => r.ok))
    assert.equal(results.filter((r) => r.value !== null).length, 1)
    assert.equal(s.job(1).attempt, 1)
    assert.equal(count(env, 'job_attempts'), 1)
  })
  await test('S01 hardening: missing envelope/provenance fields never persist', (env) => {
    const s = env.create(),
      original = event()
    for (const key of Object.keys(original)) {
      const copy: Record<string, unknown> = structuredClone(original)
      delete copy[key]
      assert.throws(() =>
        s.receivePage(
          { ...page(s, []), events: [copy] },
          { sourceInstanceId: 'source', scopeEpoch: 2 },
        ),
      )
    }
    for (const key of Object.keys(original.provenance)) {
      const copy = structuredClone(original) as unknown as {
        provenance: Record<string, unknown>
      }
      delete copy.provenance[key]
      assert.throws(() =>
        s.receivePage(
          { ...page(s, []), events: [copy] },
          { sourceInstanceId: 'source', scopeEpoch: 2 },
        ),
      )
    }
    for (const table of ['source_events', 'jobs', 'receipts'])
      assert.equal(count(env, table), 0)
    assert.equal(s.checkpoint('source', 'main').version, 0)
  })
  await test('S05 hardening: saved proposal survives process death without rerunning handler', async (env) => {
    const s = env.create()
    receive(s, [event()])
    env.crash('save', 'after-save')
    assert.ok(s.job(1).proposal)
    assert.equal(count(env, 'tasks'), 0)
    const recovered = env.open({ now: () => NOW + 1000 })
    const runner = new JobRunner(
      recovered,
      new Map([
        [
          'v1',
          async () => {
            throw new Error('HANDLER_MUST_NOT_RUN')
          },
        ],
      ]),
      { owner: 'recover', now: () => NOW + 1000 },
    )
    await runner.runOnce()
    assert.equal(s.job(1).state, 'done')
    assert.equal(count(env, 'tasks'), 1)
    assert.equal(s.job(1).attempt, 2)
    assert.equal(count(env, 'operation_commits'), 1)
  })
  await test('S05/H01 hardening: waiting handler cannot overwrite an intervening manual decision', async (env) => {
    const s = env.create()
    receive(s, [event()])
    s.submitManual('create', proposal(s, createCommands()))
    const output = deferred<DecisionProposal>(),
      began = deferred<void>()
    let late!: DecisionProposal
    const handler: JobHandler = async ({ lease }) => {
      late = jobProposal(s, lease, [
        { kind: 'set_status', taskId: 'task', status: 'waiting' },
      ])
      began.resolve()
      return output.promise
    }
    const runner = new JobRunner(s, new Map([['v1', handler]]), {
      owner: 'waiting',
      now: () => NOW,
    })
    const run = runner.runOnce()
    await began.promise
    s.submitManual(
      'manual-complete',
      proposal(s, [
        { kind: 'set_status', taskId: 'task', status: 'completed' },
      ]),
    )
    output.resolve(late)
    await run
    assert.equal(s.getTask('task')!.status, 'completed')
    assert.equal(s.getTask('task')!.evidenceStatus, 'unknown')
    assert.equal(s.job(1).state, 'retry_wait')
    assert.equal(count(env, 'decisions'), 2)
    assert.equal(count(env, 'task_revisions'), 2)
    assert.equal(count(env, 'notification_outbox'), 2)
  })
  await test('S05/Q03 hardening: in-flight handler result stays cancelled after revoke and regrant', async (env) => {
    const s = env.create()
    receive(s, [event()])
    const oldPage = page(s, [event()], 'original')
    const output = deferred<DecisionProposal>(),
      began = deferred<void>()
    let late!: DecisionProposal
    const handler: JobHandler = async ({ lease }) => {
      late = jobProposal(s, lease)
      began.resolve()
      return output.promise
    }
    const runner = new JobRunner(s, new Map([['v1', handler]]), {
      owner: 'revoked',
      now: () => NOW,
    })
    const run = runner.runOnce()
    await began.promise
    s.revokeSource('source')
    assert.equal(s.grantSource('source', ['scope'], 3), 4)
    output.resolve(late)
    await run
    assert.equal(s.job(1).state, 'cancelled')
    assert.equal(count(env, 'tasks'), 0)
    assert.throws(
      () =>
        s.receivePage(oldPage, { sourceInstanceId: 'source', scopeEpoch: 2 }),
      /STALE_AUTHORIZATION/,
    )
    assert.equal(s.claimJob('new-worker', ['v1']), null)
  })
  await test('S07 hardening: mapping source revocation is checked even without a direct event input', (env) => {
    const s = env.create()
    s.registerSource({
      id: 'right',
      provider: 'fixture',
      accountId: 'right',
      tenantId: null,
      revisionBasis: 'sequence',
    })
    s.grantSource('right', ['scope'], 1)
    const left = s.registerIdentity('source', 'people', 'same', '同名'),
      right = s.registerIdentity('right', 'people', 'same', '同名')
    assert.notEqual(left, right)
    s.confirmMapping('map', left, right, 'project', 'user')
    receive(s, [event()])
    const lease = s.claimJob('mapper', ['v1'])!,
      p = jobProposal(s, lease)
    p.mappings = [{ id: 'map', version: 1 }]
    s.revokeSource('right')
    assert.throws(() => s.commitJob(lease, p), /SOURCE_DISABLED/)
    assert.equal(count(env, 'tasks'), 0)
    assert.equal(s.job(1).state, 'running')
  })
  await test('S05 hardening: wall clock rollback before first heartbeat pauses a fast result', async (env) => {
    let time = NOW
    const s = env.create({ now: () => time })
    receive(s, [event()])
    const handler: JobHandler = async ({ lease }) => {
      const p = jobProposal(s, lease)
      time -= 1000
      return p
    }
    const runner = new JobRunner(s, new Map([['v1', handler]]), {
      owner: 'clock',
      now: () => time,
    })
    await runner.runOnce()
    assert.equal(count(env, 'tasks'), 0)
    assert.equal(s.job(1).state, 'paused')
    assert.ok(s.health().pauses.some((p) => p.code === 'CLOCK_CHANGED'))
    assert.equal(s.claimJob('later', ['v1']), null)
  })
  await test('S05 hardening: storage fencing rejects clock rollback without runner', (env) => {
    let time = NOW
    const s = env.create({ now: () => time })
    receive(s, [event()])
    const lease = s.claimJob('direct', ['v1'])!,
      p = jobProposal(s, lease)
    time--
    assert.throws(() => s.renewLease(lease), /CLOCK_CHANGED/)
    assert.throws(() => s.saveProposal(lease, p), /CLOCK_CHANGED/)
    assert.throws(() => s.commitJob(lease, p), /CLOCK_CHANGED/)
    assert.equal(count(env, 'tasks'), 0)
  })
  await test('S06 hardening: tokenizer upgrade rebuilds and failed rebuild stays degraded', (env) => {
    const s = env.create()
    s.submitManual('create', proposal(s, createCommands()))
    s.close()
    const raw = new Database(env.path)
    raw
      .prepare(
        "UPDATE store_meta SET value='retired-tokenizer' WHERE key='tokenizer_version'",
      )
      .run()
    raw.close()
    const failed = env.open({
      fault: (p) => {
        if (p === 'search:updated') throw new Error('INDEX_FAULT')
      },
    })
    assert.equal(failed.health().searchReady, false)
    assert.equal(
      failed.search({
        sourceIds: ['source'],
        projectId: 'project',
        query: '登录',
      }).fallback,
      'index_unavailable',
    )
    failed.close()
    const restored = env.open()
    assert.equal(restored.health().searchReady, true)
    assert.equal(
      restored.search({
        sourceIds: ['source'],
        projectId: 'project',
        query: '登录',
      }).fallback,
      null,
    )
  })
}

import { openStore, JOB_LEASE_MS } from '@memo/storage'
import { receiveEvent } from '@memo/application'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const at = (ms: number) => new Date(Date.UTC(2026, 8, 13) + ms)
const event = {
  schemaVersion: 1,
  sourceInstanceId: 'test',
  externalId: 'm1',
  revision: '1',
  occurredAt: at(0).toISOString(),
  role: 'user',
  text: 'synthetic queue test',
}
// A real killed process leaves its committed lease behind without close().
if (process.argv[2] === 'crash-worker') {
  const store = openStore(process.argv[3]!)
  const job = store.jobs.claim(at(0))
  writeFileSync(process.argv[4]!, JSON.stringify(job))
  setInterval(() => {}, 1000)
} else {
  void run().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'bugu-jobs-'))
  const path = join(dir, 'test.sqlite')
  let store = openStore(path)
  const other = openStore(path)
  try {
    store.registerSource('test')
    receiveEvent(store, event, 'p1')
    const first = store.jobs.claim(at(0))!
    assert.equal(first.attempt, 1)
    assert.equal(
      other.jobs.claim(at(0)),
      undefined,
      'second connection cannot claim active lease',
    )
    assert.equal(store.jobs.renew(first, at(1000)), true)
    assert.equal(other.jobs.claim(at(JOB_LEASE_MS)), undefined)
    const reclaimed = other.jobs.claim(at(JOB_LEASE_MS + 1000))!
    assert.equal(reclaimed.attempt, 2)
    assert.equal(reclaimed.errorCode, 'LEASE_EXPIRED')
    assert.equal(store.jobs.complete(first, at(JOB_LEASE_MS + 1001)), false)
    assert.equal(store.jobs.renew(first, at(JOB_LEASE_MS + 1001)), false)
    assert.equal(
      store.jobs.fail(first, 'TIMEOUT', true, at(JOB_LEASE_MS + 1001)),
      false,
    )
    assert.equal(other.jobs.complete(reclaimed, at(JOB_LEASE_MS + 1001)), true)
    assert.equal(other.jobs.complete(reclaimed, at(JOB_LEASE_MS + 1002)), false)

    receiveEvent(store, { ...event, externalId: 'retry' }, 'p2')
    const retry = store.jobs.claim(at(0))!
    assert.equal(store.jobs.fail(retry, 'RATE_LIMITED', true, at(1)), true)
    assert.equal(store.jobs.claim(at(1000)), undefined)
    const second = store.jobs.claim(at(1001))!
    assert.equal(store.jobs.fail(second, 'TIMEOUT', true, at(1002)), true)
    assert.equal(store.jobs.claim(at(3001)), undefined)
    const third = store.jobs.claim(at(3002))!
    assert.equal(store.jobs.fail(third, 'TIMEOUT', true, at(3003)), true)
    assert.equal(store.jobs.get(third.id)?.state, 'failed')
    assert.equal(store.jobs.get(third.id)?.errorCode, 'TIMEOUT')
    assert.equal(store.jobs.claim(at(1_000_000)), undefined)

    receiveEvent(store, { ...event, externalId: 'permanent' }, 'p3')
    const permanent = store.jobs.claim(at(0))!
    assert.equal(
      store.jobs.fail(permanent, 'INVALID_OUTPUT', false, at(1)),
      true,
    )
    assert.equal(store.jobs.get(permanent.id)?.attempt, 1)
    assert.equal(store.jobs.get(permanent.id)?.state, 'failed')
    assert.throws(() => store.jobs.claim(new Date(NaN)), /INVALID_JOB_TIME/)

    receiveEvent(store, { ...event, externalId: 'crash' }, 'p4')
    const ready = join(dir, 'claimed.json')
    const child = spawn(
      process.execPath,
      [process.argv[1]!, 'crash-worker', path, ready],
      { env: process.env, stdio: 'inherit' },
    )
    let childError: Error | undefined
    child.on('error', (error) => {
      childError = error
    })
    try {
      const deadline = Date.now() + 5000
      while (
        !existsSync(ready) &&
        Date.now() < deadline &&
        !childError &&
        child.exitCode === null
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (childError) throw childError
      assert.ok(
        existsSync(ready),
        'worker must persist a lease before being killed',
      )
      const crashed = JSON.parse(readFileSync(ready, 'utf8')) as {
        id: number
        attempt: number
      }
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      )
      child.kill('SIGKILL')
      await exited
      store.close()
      store = openStore(path)
      assert.equal(store.jobs.claim(at(JOB_LEASE_MS - 1)), undefined)
      const recovered = store.jobs.claim(at(JOB_LEASE_MS))!
      assert.equal(recovered.id, crashed.id)
      assert.equal(recovered.attempt, 2)
      assert.equal(store.jobs.complete(crashed, at(JOB_LEASE_MS + 1)), false)
      const last = store.jobs.claim(at(JOB_LEASE_MS * 2))!
      assert.equal(last.attempt, 3)
      assert.equal(
        store.jobs.complete(last, at(JOB_LEASE_MS * 3)),
        false,
        'expired worker cannot complete even before reclaim',
      )
      assert.equal(store.jobs.claim(at(JOB_LEASE_MS * 3)), undefined)
      assert.equal(store.jobs.get(last.id)?.state, 'failed')
      assert.equal(store.jobs.get(last.id)?.errorCode, 'LEASE_EXPIRED')
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL')
    }
    console.log(
      'Job queue integration passed: fencing, retries, two connections, SIGKILL recovery',
    )
  } finally {
    store.close()
    other.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

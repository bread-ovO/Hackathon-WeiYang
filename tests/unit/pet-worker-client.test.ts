import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocked = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mocked.fork } }))
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }))
import { PetWorkerClient } from '../../apps/desktop/src/main/pet/worker-client'
import {
  validRequest,
  validReply,
  slimWorkerData,
} from '../../apps/desktop/src/main/pet/worker-protocol'
class Child extends EventEmitter {
  postMessage = vi.fn()
  kill = vi.fn()
}
const state = { currentModelId: null, models: [] }
describe('pet worker process boundary', () => {
  let child: Child, client: PetWorkerClient
  beforeEach(() => {
    vi.useFakeTimers()
    child = new Child()
    mocked.fork.mockReturnValue(child)
    client = new PetWorkerClient('/worker.js', '/isolated/store', mocked.fork)
    client.start()
  })
  afterEach(() => {
    client.stop()
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  it('queues the first screen until ready, snapshots params, and validates reply', async () => {
    const p = { directory: '/models' }
    const result = client.request('discover', p)
    p.directory = '/changed'
    expect(child.postMessage).not.toHaveBeenCalled()
    child.emit('message', { ready: true })
    expect(child.postMessage.mock.calls[0]![0].params.directory).toBe('/models')
    child.emit('message', {
      id: child.postMessage.mock.calls[0]![0].id,
      reply: {
        ok: true,
        data: { entries: ['m.model3.json'], cmo3Found: false },
      },
    })
    await expect(result).resolves.toEqual({
      ok: true,
      data: { entries: ['m.model3.json'], cmo3Found: false },
    })
  })
  it('bounds startup waiting and never restarts after failure', async () => {
    const result = client.request('list')
    await vi.advanceTimersByTimeAsync(5000)
    await expect(result).resolves.toEqual({
      ok: false,
      error: 'PET_UNAVAILABLE',
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    client.start()
    expect(mocked.fork).toHaveBeenCalledTimes(1)
  })
  it('kills on timeout and flushes all operations so a write cannot keep running', async () => {
    child.emit('message', { ready: true })
    const first = client.request('import', {
        directory: '/models',
        entry: 'm.model3.json',
      }),
      second = client.request('list')
    await vi.advanceTimersByTimeAsync(30000)
    expect(child.kill).toHaveBeenCalledTimes(1)
    await expect(first).resolves.toEqual({
      ok: false,
      error: 'PET_UNAVAILABLE',
    })
    await expect(second).resolves.toEqual({
      ok: false,
      error: 'PET_UNAVAILABLE',
    })
    await expect(client.request('list')).resolves.toEqual({
      ok: false,
      error: 'PET_UNAVAILABLE',
    })
    child.emit('message', {
      id: child.postMessage.mock.calls[0]![0].id,
      reply: { ok: true, data: state },
    })
    client.start()
    expect(mocked.fork).toHaveBeenCalledTimes(1)
  })
  it('limits pending operations and rejects malformed requests without posting', async () => {
    child.emit('message', { ready: true })
    await expect(
      client.request('remove', { modelId: '../bad' }),
    ).resolves.toEqual({ ok: false, error: 'INVALID_REQUEST' })
    const pending = Array.from({ length: 8 }, () => client.request('list'))
    await expect(client.request('list')).resolves.toEqual({
      ok: false,
      error: 'PET_UNAVAILABLE',
    })
    expect(child.postMessage).toHaveBeenCalledTimes(8)
    client.stop()
    await Promise.all(pending)
  })
  it.each([
    { ok: false, error: '/secret/token' },
    { ok: true, data: { ...state, path: '/private' } },
    { ok: true, data: { currentModelId: 'missing', models: [] } },
    { ok: true, data: { ...state, extra: 'x'.repeat(1024 * 1024) } },
  ])('kills on forged or oversized response', async (reply) => {
    child.emit('message', { ready: true })
    const result = client.request('list')
    child.emit('message', { id: child.postMessage.mock.calls[0]![0].id, reply })
    await expect(result).resolves.toEqual({
      ok: false,
      error: 'PET_UNAVAILABLE',
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
  it('flushes on exit and refuses automatic recovery until app restart', async () => {
    const p = client.request('list')
    child.emit('exit', 1)
    await expect(p).resolves.toEqual({ ok: false, error: 'PET_UNAVAILABLE' })
    client.start()
    expect(mocked.fork).toHaveBeenCalledTimes(1)
  })
  it('returns immutable reply snapshots and supports remove', async () => {
    child.emit('message', { ready: true })
    const p = client.request('remove', { modelId: 'a'.repeat(64) })
    const data = { currentModelId: null, models: [] }
    child.emit('message', {
      id: child.postMessage.mock.calls[0]![0].id,
      reply: { ok: true, data },
    })
    Object.assign(data, { path: '/secret' })
    await expect(p).resolves.toEqual({ ok: true, data: state })
  })
})
describe('pet wire schema', () => {
  it('rejects extra privilege fields and unknown methods', () => {
    expect(validRequest({ id: 'id', method: 'list', path: '/private' })).toBe(
      false,
    )
    expect(validRequest({ id: 'id', method: 'exec', params: {} })).toBe(false)
    expect(
      validRequest({
        id: 'id',
        method: 'import',
        params: { directory: '/models', entry: '../m.model3.json' },
      }),
    ).toBe(false)
    expect(
      validRequest({ id: 'id', method: 'remove', params: { modelId: null } }),
    ).toBe(false)
  })
  it('removes raw resources and issue paths from replies', () => {
    const model = {
      id: 'a'.repeat(64),
      entry: 'm.model3.json',
      importedAt: '2026-09-13T00:00:00.000Z',
      totalBytes: 1,
      resources: [{ path: '/secret' }],
    }
    const slim = slimWorkerData({ status: 'imported', model }, 'import')
    expect(validReply({ ok: true, data: slim }, 'import')).toBe(true)
    expect(JSON.stringify(slim)).not.toContain('resources')
    expect(
      slimWorkerData(
        {
          status: 'invalid',
          issues: [
            {
              code: 'invalid-path',
              resource: 'https://secret',
              message: '/private',
            },
          ],
        },
        'import',
      ),
    ).toEqual({
      status: 'invalid',
      issues: [
        { code: 'invalid-path', resource: '', message: '模型资源未通过检查。' },
      ],
    })
  })
})

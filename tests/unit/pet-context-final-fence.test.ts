import { describe, expect, it, vi } from 'vitest'
import {
  createPetContextService,
  type PetContextServiceDeps,
} from '../../apps/desktop/src/main/pet/context-service'
import type { PetContextFact } from '../../packages/contracts/src/pet-context-facts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(valid: PetContextServiceDeps['valid']) {
  const fact: PetContextFact = {
    projectId: 'synthetic-project',
    taskId: 'synthetic-task',
    taskVersion: 1,
    criteriaVersion: 1,
    manualVersion: 1,
    title: '合成验收事项',
    status: 'todo',
    referenceId: 'manual:synthetic-reference',
    eventId: 1,
    proof: 'a'.repeat(64),
  }
  const enqueue = vi.fn(() => 'synthetic-presentation')
  const enqueueFallback = vi.fn(() => 'synthetic-fallback')
  const service = createPetContextService({
    store: { load: async () => null, save: async () => undefined },
    facts: async () => [fact],
    valid,
    select: async () => ({ ref: 'r1', template: 'open' }),
    enqueue,
    enqueueFallback,
    cancelPresentation: vi.fn(),
    navigate: vi.fn(),
    isCurrent: () => true,
    changed: vi.fn(),
    now: () => Date.parse('2026-09-13T10:00:00Z'),
  })
  await service.ready
  await service.configure(1, {
    enabled: true,
    projectIds: ['synthetic-project'],
    useModel: false,
    model: '',
  })
  const preview = await service.preview()
  return {
    service,
    enqueue,
    enqueueFallback,
    prepared: { text: preview.text, contextId: preview.id },
  }
}

describe('context speech final delivery fences', () => {
  it('rejects a fact invalidated while the asynchronous environment guard waits', async () => {
    let valid = true
    const f = await fixture(async () => valid)
    const entered = deferred<void>(),
      release = deferred<boolean>()
    const delivery = f.service.deliver(f.prepared, undefined, async () => {
      entered.resolve()
      return release.promise
    })
    await entered.promise
    valid = false
    release.resolve(true)
    expect(await delivery).toBeNull()
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(f.enqueueFallback).not.toHaveBeenCalled()
    f.service.dispose()
  })

  it('rejects when quiet time begins during the final asynchronous fact validation', async () => {
    const entered = deferred<void>(),
      release = deferred<boolean>()
    let finalCheck = false,
      quiet = false
    const f = await fixture(async () => {
      if (finalCheck) {
        entered.resolve()
        return release.promise
      }
      return true
    })
    const delivery = f.service.deliver(
      f.prepared,
      undefined,
      async () => {
        finalCheck = true
        return true
      },
      () => !quiet,
    )
    await entered.promise
    quiet = true
    release.resolve(true)
    expect(await delivery).toBeNull()
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(f.enqueueFallback).not.toHaveBeenCalled()
    f.service.dispose()
  })

  it('rejects cancellation during final fact validation without emitting fallback', async () => {
    const entered = deferred<void>(),
      release = deferred<boolean>()
    let finalCheck = false
    const f = await fixture(async () => {
      if (finalCheck) {
        entered.resolve()
        return release.promise
      }
      return true
    })
    const delivery = f.service.deliver(f.prepared, undefined, async () => {
      finalCheck = true
      return true
    })
    const rejected = expect(delivery).rejects.toThrow('PET_MODEL_CANCELLED')
    await entered.promise
    f.service.cancel()
    release.resolve(true)
    await rejected
    expect(f.enqueue).not.toHaveBeenCalled()
    expect(f.enqueueFallback).not.toHaveBeenCalled()
    f.service.dispose()
  })
})

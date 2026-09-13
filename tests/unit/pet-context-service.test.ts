import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPetContextStore } from '../../apps/desktop/src/main/pet/context-store'
import { describe, it, expect, vi } from 'vitest'
import { symlinkOrSkip } from './helpers/symlink-or-skip'
import {
  createPetContextService,
  parseContextStoreState,
  type ContextStoreState,
  type PetContextServiceDeps,
} from '../../apps/desktop/src/main/pet/context-service'
import type { PetContextFact } from '../../packages/contracts/src/pet-context-facts'
const fact: PetContextFact = {
  projectId: 'project-a',
  taskId: 'task-a',
  taskVersion: 1,
  criteriaVersion: 1,
  manualVersion: 1,
  title: '合成事项',
  status: 'in_progress',
  referenceId: 'manual:ref-a',
  eventId: 1,
  proof: 'a'.repeat(64),
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture(
  patch: Partial<PetContextServiceDeps> = {},
  saved?: ContextStoreState,
) {
  let time = Date.parse('2026-09-13T10:00:00Z'),
    persisted: ContextStoreState | null = saved ? structuredClone(saved) : null
  const deps: PetContextServiceDeps = {
    store: {
      load: vi.fn(async () => (persisted ? structuredClone(persisted) : null)),
      save: vi.fn(async (s) => {
        persisted = structuredClone(s)
      }),
    },
    facts: vi.fn(async () => [structuredClone(fact)]),
    valid: vi.fn(async () => true),
    select: vi.fn(async () => ({ ref: 'r1', template: 'open' as const })),
    enqueue: vi.fn(() => 'presentation-1'),
    enqueueFallback: vi.fn(() => 'fallback-1'),
    cancelPresentation: vi.fn(),
    navigate: vi.fn(),
    isCurrent: vi.fn(() => true),
    changed: vi.fn(),
    now: () => time,
    ...patch,
  }
  const service = createPetContextService(deps)
  return {
    service,
    deps,
    get stored() {
      return persisted
    },
    advance(n: number) {
      time += n
    },
    setTime(n: number) {
      time = n
    },
  }
}
const config = {
  enabled: true,
  projectIds: ['project-a'],
  useModel: false,
  model: '',
}
async function configured(
  patch: Partial<PetContextServiceDeps> = {},
  model = false,
) {
  const f = fixture(patch)
  await f.service.ready
  await f.service.configure(1, {
    ...config,
    useModel: model,
    model: model ? 'qwen3:4b' : '',
  })
  return f
}
describe('context speech runtime', () => {
  it('defaults disabled and uses preset without querying facts/model', async () => {
    const f = fixture()
    await f.service.ready
    const p = await f.service.preview()
    expect(p.hasReference).toBe(false)
    expect(p.text).not.toContain(fact.title)
    expect(f.deps.facts).not.toHaveBeenCalled()
    expect(f.deps.select).not.toHaveBeenCalled()
    expect(f.service.state().config.enabled).toBe(false)
  })
  it('selects a real local fact, opaque single-use preview and private navigation', async () => {
    const f = await configured()
    const p = await f.service.preview()
    expect(p.id).not.toContain('task-a')
    expect(p.text).toContain(fact.title)
    expect(p.mode).toBe('local')
    expect(p.hasReference).toBe(true)
    expect(f.deps.enqueue).not.toHaveBeenCalled()
    await f.service.show(p.id)
    expect(f.deps.enqueue).toHaveBeenCalledOnce()
    await expect(f.service.show(p.id)).rejects.toThrow()
    expect(await f.service.open('wrong')).toBe(false)
    expect(await f.service.open('presentation-1')).toBe(true)
    expect(f.deps.navigate).toHaveBeenCalledWith('project-a', 'task-a')
    expect(f.stored!.recent).toEqual(['task-a'])
  })
  it('refuses expired previews and time rollback, invalid or no-longer-current references', async () => {
    const f = await configured()
    const p = await f.service.preview()
    f.advance(60_001)
    await expect(f.service.show(p.id)).rejects.toThrow()
    expect(f.deps.enqueue).not.toHaveBeenCalled()
    const p2 = await f.service.preview()
    f.advance(-1)
    await expect(f.service.show(p2.id)).rejects.toThrow()
    f.advance(1)
    const p3 = await f.service.preview()
    vi.mocked(f.deps.valid).mockResolvedValue(false)
    await expect(f.service.show(p3.id)).rejects.toThrow()
    expect(f.deps.enqueue).not.toHaveBeenCalled()
  })
  it('does not navigate when reference or current presentation changes while validation awaits', async () => {
    const f = await configured()
    const p = await f.service.preview()
    await f.service.show(p.id)
    const d = deferred<boolean>()
    vi.mocked(f.deps.valid).mockReturnValueOnce(d.promise)
    const opened = f.service.open('presentation-1')
    await Promise.resolve()
    vi.mocked(f.deps.isCurrent).mockReturnValue(false)
    d.resolve(true)
    expect(await opened).toBe(false)
    expect(f.deps.navigate).not.toHaveBeenCalled()
  })
  it('does not navigate when reference validation crosses preview expiry', async () => {
    const f = await configured(),
      p = await f.service.preview()
    await f.service.show(p.id)
    f.advance(59_999)
    const d = deferred<boolean>()
    vi.mocked(f.deps.valid).mockReturnValueOnce(d.promise)
    const opened = f.service.open('presentation-1')
    await Promise.resolve()
    f.advance(2)
    d.resolve(true)
    expect(await opened).toBe(false)
    expect(f.deps.navigate).not.toHaveBeenCalled()
  })
  it('persists reservation before request and sends only anonymous refs/status', async () => {
    let f: Awaited<ReturnType<typeof configured>>
    f = await configured(
      {
        select: vi.fn(async (input) => {
          expect(f.stored!.count).toBe(1)
          expect(input.candidates).toEqual([
            { ref: 'r1', status: 'in_progress' },
          ])
          expect(JSON.stringify(input)).not.toContain('合成事项')
          return { ref: 'r1', template: 'review' as const }
        }),
      },
      true,
    )
    const p = await f.service.preview()
    expect(p.mode).toBe('model')
    expect(p.text).toContain('可以看看')
    expect(p.text).toContain(fact.title)
  })
  it('cancel and hide discard late model success without fallback or presentation', async () => {
    for (const kind of ['cancel', 'invalidateDisplay'] as const) {
      const d = deferred<{ ref: string; template: 'open' }>(),
        started = deferred<void>()
      const f = await configured(
        {
          select: vi.fn(async () => {
            started.resolve()
            return d.promise
          }),
        },
        true,
      )
      const c = new AbortController(),
        pending = f.service.prepareAutomatic('预设', c.signal)
      await started.promise
      f.service[kind]()
      d.resolve({ ref: 'r1', template: 'open' })
      expect(await pending).toBeNull()
      expect(f.deps.enqueue).not.toHaveBeenCalled()
      expect(f.deps.enqueueFallback).not.toHaveBeenCalled()
      expect(f.stored!.count).toBe(1)
    }
  })
  it('external cancellation and disposal discard facts returning late', async () => {
    for (const dispose of [false, true]) {
      const f = await configured(),
        d = deferred<PetContextFact[]>()
      vi.mocked(f.deps.facts).mockReturnValueOnce(d.promise)
      const c = new AbortController(),
        pending = f.service.prepareAutomatic('预设', c.signal)
      await Promise.resolve()
      if (dispose) f.service.dispose()
      else c.abort()
      d.resolve([fact])
      expect(await pending).toBeNull()
      expect(f.deps.select).not.toHaveBeenCalled()
    }
  })
  it('model failure falls back once without provider raw error or contextual title', async () => {
    const f = await configured(
      {
        select: vi.fn(async () => {
          throw Error('秘密模型输出：' + fact.title)
        }),
      },
      true,
    )
    const c = new AbortController(),
      prepared = await f.service.prepareAutomatic('固定预设', c.signal)
    expect(prepared).toMatchObject({
      text: '固定预设',
      contextId: expect.any(String),
    })
    expect(f.service.state().error).toBe('PET_MODEL_UNAVAILABLE')
    await f.service.deliver(prepared!, c.signal)
    expect(f.deps.enqueueFallback).toHaveBeenCalledExactlyOnceWith('固定预设')
    expect(f.deps.enqueue).not.toHaveBeenCalled()
    expect(JSON.stringify(f.stored)).not.toContain(fact.title)
  })
  it('does not repeat the only available fact on consecutive deliveries and retains the fence after restart', async () => {
    const f = await configured()
    const first = await f.service.preview()
    expect(first.hasReference).toBe(true)
    await f.service.show(first.id)
    const restarted = fixture({}, f.stored!)
    await restarted.service.ready
    const second = await restarted.service.preview()
    expect(second.hasReference).toBe(false)
    expect(second.text).not.toContain(fact.title)
    await restarted.service.show(second.id)
    expect(restarted.deps.enqueueFallback).toHaveBeenCalledTimes(1)
    const third = await restarted.service.preview()
    expect(third.hasReference).toBe(true)
  })
  it('does not enqueue if environment guard becomes suppressed', async () => {
    const f = await configured()
    const prepared = await f.service.prepareAutomatic(
      '预设',
      new AbortController().signal,
    )
    expect(
      await f.service.deliver(prepared!, undefined, async () => false),
    ).toBeNull()
    expect(f.deps.enqueue).not.toHaveBeenCalled()
    expect(f.deps.enqueueFallback).not.toHaveBeenCalled()
  })
  it('rejects stale concurrent configuration CAS and removes pending/shown entries', async () => {
    const f = await configured()
    const p = await f.service.preview()
    await f.service.show(p.id)
    const [one, two] = await Promise.allSettled([
      f.service.configure(2, { ...config, enabled: false }),
      f.service.configure(2, { ...config, enabled: true }),
    ])
    expect(one.status).toBe('fulfilled')
    expect(two.status).toBe('rejected')
    expect(f.service.state().config.version).toBe(3)
    expect(f.deps.cancelPresentation).toHaveBeenCalledWith('presentation-1')
    expect(await f.service.open('presentation-1')).toBe(false)
  })
  it('does not run old configuration when preview races a pending disable', async () => {
    const f = await configured({}, true),
      validation = deferred<PetContextFact[]>(),
      started = deferred<void>()
    vi.mocked(f.deps.facts).mockImplementationOnce(async () => {
      started.resolve()
      return validation.promise
    })
    const changing = f.service.configure(2, {
      ...config,
      enabled: false,
      useModel: false,
      model: '',
    })
    await started.promise
    const preview = f.service.preview().catch(() => null)
    await Promise.resolve()
    await Promise.resolve()
    validation.resolve([fact])
    await changing
    await preview
    expect(f.deps.select).not.toHaveBeenCalled()
  })
  it('cancellation during fallback final environment check prevents delivery', async () => {
    const f = fixture()
    await f.service.ready
    const gate = deferred<boolean>(),
      started = deferred<void>()
    const delivery = f.service
      .deliver({ text: '预设' }, undefined, async () => {
        started.resolve()
        return gate.promise
      })
      .catch(() => null)
    await started.promise
    f.service.cancel()
    gate.resolve(true)
    expect(await delivery).toBeNull()
    expect(f.deps.enqueueFallback).not.toHaveBeenCalled()
  })
  it('retains ten second model cooldown after restart', async () => {
    const f = await configured({}, true)
    await f.service.preview()
    const g = fixture({}, f.stored!)
    await g.service.ready
    expect((await g.service.preview()).mode).toBe('fallback')
    expect(g.deps.select).not.toHaveBeenCalled()
    expect(g.service.state().error).toBe('PET_CONTEXT_COOLDOWN')
    g.advance(10000)
    expect((await g.service.preview()).mode).toBe('model')
  })
  it('retains request budget and cooldown across restart, blocks clock rollback', async () => {
    const f = await configured({}, true)
    for (let n = 0; n < 12; n++) {
      if (n) f.advance(10_000)
      expect((await f.service.preview()).mode).toBe('model')
    }
    f.advance(10_000)
    expect((await f.service.preview()).mode).toBe('fallback')
    expect(f.service.state().error).toBe('PET_CONTEXT_BUDGET')
    expect(f.deps.select).toHaveBeenCalledTimes(12)
    const g = fixture({}, f.stored!)
    g.setTime(f.stored!.lastNow + 20_000)
    await g.service.ready
    expect((await g.service.preview()).mode).toBe('fallback')
    expect(g.deps.select).not.toHaveBeenCalled()
    g.setTime(f.stored!.lastNow - 1)
    expect((await g.service.preview()).mode).toBe('fallback')
    expect(g.service.state().error).toBe('PET_CONTEXT_COOLDOWN')
    g.setTime(Date.parse('2026-09-14T10:00:00Z'))
    expect((await g.service.preview()).mode).toBe('model')
    expect(g.stored!.count).toBe(1)
  })
  it('blocks concurrent request and persistent reservation failure before model', async () => {
    const f = await configured({}, true),
      d = deferred<{ ref: string; template: 'open' }>(),
      started = deferred<void>()
    vi.mocked(f.deps.select).mockImplementationOnce(async () => {
      started.resolve()
      return d.promise
    })
    const pending = f.service.preview()
    await started.promise
    await expect(f.service.preview()).rejects.toThrow('PET_MODEL_BUSY')
    d.resolve({ ref: 'r1', template: 'open' })
    await pending
    f.advance(10_000)
    vi.mocked(f.deps.store.save).mockRejectedValueOnce(
      Error('disk path private'),
    )
    await f.service.preview().catch(() => undefined)
    expect(f.deps.select).toHaveBeenCalledOnce()
    await expect(f.service.preview()).rejects.toThrow(
      'PET_CONTEXT_STORAGE_ERROR',
    )
  })
  it('fails closed on corrupt persisted state without any fact or model query', async () => {
    const f = fixture({
      store: {
        load: async () => ({ bad: true }) as unknown as ContextStoreState,
        save: vi.fn(),
      },
    })
    await f.service.ready
    expect(f.service.state().error).toBe('PET_CONTEXT_STORAGE_ERROR')
    await expect(f.service.preview()).rejects.toThrow(
      'PET_CONTEXT_STORAGE_ERROR',
    )
    expect(f.deps.facts).not.toHaveBeenCalled()
    expect(f.deps.select).not.toHaveBeenCalled()
    expect(() => parseContextStoreState({})).toThrow()
  })
})

describe('context state store in isolated profile', () => {
  it('roundtrips preference and reservation only, rejects malformed state and oversized files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugu-context-store-'))
    try {
      const store = createPetContextStore(join(dir, 'context.json'))
      expect(await store.load()).toBeNull()
      const f = await configured({}, true)
      await f.service.preview()
      await store.save(f.stored!)
      expect(await store.load()).toEqual(f.stored)
      const invalid = [
        { ...f.stored!, version: 2 },
        { ...f.stored!, count: 13 },
        { ...f.stored!, count: 1.5 },
        { ...f.stored!, day: '2026-02-30' },
        { ...f.stored!, lastRequestAt: f.stored!.lastNow + 1 },
        { ...f.stored!, recent: ['same', 'same'] },
        { ...f.stored!, secret: 'extra' },
      ]
      for (const value of invalid) {
        expect(() => parseContextStoreState(value)).toThrow()
        await expect(store.save(value as ContextStoreState)).rejects.toThrow()
      }
      await writeFile(join(dir, 'context.json'), 'x'.repeat(16385))
      await expect(store.load()).rejects.toThrow('PET_CONTEXT_STORAGE_ERROR')
      await writeFile(join(dir, 'context.json'), '{broken')
      await expect(store.load()).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('refuses symlink/nonregular reads and failed publish cleans staging files', async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), 'bugu-context-store-'))
    try {
      const f = await configured()
      await writeFile(join(dir, 'original.json'), JSON.stringify(f.stored))
      await symlinkOrSkip(ctx, join(dir, 'original.json'), join(dir, 'link.json'))
      await expect(
        createPetContextStore(join(dir, 'link.json')).load(),
      ).rejects.toThrow('PET_CONTEXT_STORAGE_ERROR')
      await mkdir(join(dir, 'directory.json'))
      const blocked = createPetContextStore(join(dir, 'directory.json'))
      await expect(blocked.load()).rejects.toThrow('PET_CONTEXT_STORAGE_ERROR')
      await expect(blocked.save(f.stored!)).rejects.toThrow()
      expect((await readdir(dir)).some((name) => name.endsWith('.tmp'))).toBe(
        false,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

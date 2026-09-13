import { expect, it, vi } from 'vitest'
const operations = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  importModel: vi.fn(),
  select: vi.fn(),
  discover: vi.fn(),
}))
vi.mock('../../apps/desktop/src/main/pet/model-store', () => ({
  ModelStore: class {
    list = operations.list
    remove = operations.remove
    importModel = operations.importModel
    select = operations.select
  },
  ModelStoreError: class extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  },
}))
vi.mock('../../apps/desktop/src/main/pet/import-session', () => ({
  findModelEntries: operations.discover,
  ModelDiscoveryError: class extends Error {
    code = 'source-changed'
  },
}))
it('serializes discovery/import/removal and bounds worker-side queue independently', async () => {
  const oldArg = process.argv[2],
    descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort')
  let receive!: (e: { data: unknown }) => void
  const postMessage = vi.fn()
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: {
      on: (_name: string, listener: typeof receive) => {
        receive = listener
      },
      postMessage,
    },
  })
  process.argv[2] = '/isolated/store'
  let finish!: (v: unknown) => void
  operations.discover.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r
      }),
  )
  operations.remove.mockResolvedValue({ currentModelId: null, models: [] })
  operations.list.mockResolvedValue({ currentModelId: null, models: [] })
  try {
    await import('../../apps/desktop/src/main/pet/worker')
    expect(postMessage).toHaveBeenCalledWith({ ready: true })
    receive({
      data: { id: '1', method: 'discover', params: { directory: '/models' } },
    })
    receive({
      data: { id: '2', method: 'remove', params: { modelId: 'a'.repeat(64) } },
    })
    for (let i = 3; i <= 9; i++)
      receive({ data: { id: String(i), method: 'list' } })
    await Promise.resolve()
    expect(operations.discover).toHaveBeenCalledWith('/models')
    expect(operations.remove).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith({
      id: '9',
      reply: { ok: false, error: 'PET_UNAVAILABLE' },
    })
    finish({ entries: ['a.model3.json'], cmo3Found: false })
    await vi.waitFor(() =>
      expect(operations.remove).toHaveBeenCalledWith('a'.repeat(64)),
    )
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        id: '8',
        reply: { ok: true, data: { currentModelId: null, models: [] } },
      }),
    )
    receive({
      data: {
        id: 'bad',
        method: 'import',
        params: { directory: '/models', entry: '../x' },
      },
    })
    expect(postMessage).toHaveBeenCalledWith({
      id: 'bad',
      reply: { ok: false, error: 'INVALID_REQUEST' },
    })

    const model = {
      id: 'a'.repeat(64),
      entry: 'm.model3.json',
      importedAt: '2026-09-13T00:00:00.000Z',
      totalBytes: 2,
      resources: [
        {
          path: 'm.model3.json',
          kind: 'manifest',
          bytes: 2,
          sha256: 'c'.repeat(64),
        },
      ],
    }
    operations.list.mockResolvedValue({
      currentModelId: model.id,
      models: [model, { ...model, id: 'b'.repeat(64) }],
    })
    receive({
      data: {
        id: 'render-current',
        method: 'renderModel',
        params: { modelId: model.id },
      },
    })
    receive({
      data: {
        id: 'render-other',
        method: 'renderModel',
        params: { modelId: 'b'.repeat(64) },
      },
    })
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        id: 'render-current',
        reply: { ok: true, data: { model } },
      }),
    )
    await vi.waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith({
        id: 'render-other',
        reply: { ok: false, error: 'unknown-model' },
      }),
    )
  } finally {
    if (oldArg === undefined) delete process.argv[2]
    else process.argv[2] = oldArg
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor)
    else Reflect.deleteProperty(process, 'parentPort')
  }
})

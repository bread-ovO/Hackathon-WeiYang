import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  handlers: new Map<string, Function>(),
  windows: [] as any[],
  runtime: vi.fn(async () => true),
  model: vi.fn(async () => ({
    ok: true,
    data: {
      model: { id: 'a'.repeat(64), entry: 'a.model3.json', resources: [] },
    },
  })),
  protocol: undefined as Function | undefined,
  network: undefined as Function | undefined,
}))
vi.mock('../../apps/desktop/node_modules/electron', () => ({
  ipcMain: {
    handle: (name: string, handler: Function) =>
      mock.handlers.set(name, handler),
    removeHandler: (name: string) => mock.handlers.delete(name),
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: {
        onBeforeRequest: (fn: Function) => {
          mock.network = fn
        },
      },
      protocol: {
        handle: (_name: string, fn: Function) => {
          mock.protocol = fn
        },
        unhandle: vi.fn(),
      },
    }),
  },
  screen: {
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1000, height: 800 },
    }),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: class {
    visible = false
    dead = false
    handlers = new Map()
    bounds = { x: 0, y: 0, width: 320, height: 420 }
    webContents = {
      mainFrame: { url: 'memo-pet://app/pet.html' },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    constructor(readonly options: unknown) {
      mock.windows.push(this)
    }
    on(name: string, fn: Function) {
      this.handlers.set(name, fn)
    }
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    loadURL = vi.fn(async () => {})
    showInactive() {
      this.visible = true
    }
    hide() {
      this.visible = false
    }
    destroy() {
      this.dead = true
      this.visible = false
    }
    isDestroyed() {
      return this.dead
    }
    isVisible() {
      return this.visible
    }
    setBounds(b: any) {
      this.bounds = b
    }
    getBounds() {
      return this.bounds
    }
  },
}))
vi.mock('../../apps/desktop/src/main/pet/runtime-store', () => ({
  createRuntimeStore: () => ({
    status: mock.runtime,
    install: vi.fn(),
    read: vi.fn(),
  }),
  safeResourcePath: (s: string) => !s.includes('..'),
}))
import {
  createPetDesktopController,
  validPetReport,
} from '../../apps/desktop/src/main/pet/desktop-controller'
const id = 'a'.repeat(64)
function create(
  stateReader?: () => Promise<any>,
  mutations: { select?: () => Promise<any>; remove?: () => Promise<any> } = {},
) {
  return createPetDesktopController({
    worker: { request: mock.model } as any,
    flow: {
      state:
        stateReader ??
        (async () => ({
          ok: true,
          data: { currentModelId: id, models: [], display: false },
        })),
      select: mutations.select ?? vi.fn(),
      remove: mutations.remove ?? vi.fn(),
    } as any,
    modelRoot: '/fake',
    runtimeRoot: '/fake',
    rendererRoot: '/fake',
    preloadPath: '/fake/pet.js',
    pickRuntimeDirectory: async () => null,
  })
}
beforeEach(() => {
  mock.handlers.clear()
  mock.windows.length = 0
  mock.runtime.mockResolvedValue(true)
  mock.model.mockResolvedValue({
    ok: true,
    data: { model: { id, entry: 'a.model3.json', resources: [] } },
  })
})
describe('isolated pet desktop host', () => {
  it('destroys a failed renderer and preserves its safe error for settings', async () => {
    const host = create()
    await host.show()
    const win = mock.windows[0]
    mock.handlers.get('memo-pet:report')!(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { modelId: id, status: 'error', code: 'SHADER_TIMEOUT' },
    )
    await vi.waitFor(() => expect(win.dead).toBe(true))
    expect(await host.state()).toMatchObject({
      ok: true,
      data: {
        display: false,
        renderStatus: 'error',
        renderError: 'SHADER_TIMEOUT',
      },
    })
    host.dispose()
  })
  it('creates a sandbox window only after explicit show and rejects other senders and subframes', async () => {
    const host = create()
    expect(mock.windows).toHaveLength(0)
    await host.show()
    const win = mock.windows[0]
    expect(win.options).toMatchObject({
      show: false,
      alwaysOnTop: false,
      transparent: true,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    const read = mock.handlers.get('memo-pet:state')!
    expect(() => read({ sender: {}, senderFrame: {} })).toThrow(
      'INVALID_PET_SENDER',
    )
    expect(() =>
      read({
        sender: win.webContents,
        senderFrame: { url: 'memo-pet://app/pet.html' },
      }),
    ).toThrow('INVALID_PET_SENDER')
    const event = {
      sender: win.webContents,
      senderFrame: win.webContents.mainFrame,
    }
    expect(read(event)).toEqual({
      model: { id, entry: 'a.model3.json' },
      visible: true,
      catalog: { motions: [], expressions: [] },
      presentation: null,
      preferences: { scale: 1, alwaysOnTop: false, clickThrough: true },
    })
    const hit = mock.handlers.get('memo-pet:hitTest')!,
      drag = mock.handlers.get('memo-pet:drag')!
    expect(() => hit(event, { interactive: 'yes' })).toThrow()
    expect(() => hit(event, { interactive: true, x: 100 })).toThrow()
    expect(() => drag(event, { phase: ['start'] })).toThrow()
    expect(() => drag(event, { phase: 'move', x: 100 })).toThrow()
    expect(() =>
      hit({ sender: {}, senderFrame: {} }, { interactive: true }),
    ).toThrow()
    expect(await host.configure({ scale: NaN })).toMatchObject({
      ok: false,
      error: 'INVALID_REQUEST',
    })
    expect(
      await host.configure({
        scale: 2,
        alwaysOnTop: true,
        clickThrough: false,
      }),
    ).toMatchObject({
      ok: true,
      data: {
        preferences: { scale: 2, alwaysOnTop: true, clickThrough: false },
      },
    })
    expect(await host.speak({ text: '未ready' })).toMatchObject({ ok: false })
    const report = mock.handlers.get('memo-pet:report')!
    expect(() =>
      report(event, { modelId: 'b'.repeat(64), status: 'ready' }),
    ).toThrow()
    report(event, { modelId: id, status: 'ready' })
    expect(await host.play('unknown')).toMatchObject({
      ok: false,
      error: 'INVALID_REQUEST',
    })
    expect(await host.speak({ text: '第一句' })).toMatchObject({ ok: true })
    const first = read(event).presentation
    await host.speak({ text: '第二句' })
    expect(read(event).presentation.id).toBe(first.id)
    const ack = mock.handlers.get('memo-pet:ack')!
    expect(() => ack(event, { id: 'wrong', status: 'done' })).toThrow()
    expect(() =>
      ack(event, { id: first.id, status: 'done', extra: true }),
    ).toThrow()
    ack(event, { id: first.id, status: 'done' })
    expect(read(event).presentation.text).toBe('第二句')
    await host.dismissBubble()
    expect(read(event).presentation).toBeNull()

    expect(await host.show()).toMatchObject({
      ok: true,
      data: { renderStatus: 'ready' },
    })
    expect(mock.windows).toHaveLength(1)
    expect(() => read(event, 'extra')).toThrow()
    expect(() =>
      report(event, { modelId: id, status: 'ready' }, 'extra'),
    ).toThrow()
    await host.hide()
    expect(win.dead).toBe(true)
    expect(() => report(event, { modelId: id, status: 'ready' })).toThrow()
    host.dispose()
    expect(mock.handlers.size).toBe(0)
  })
  it('hiding during model validation prevents the late window', async () => {
    let resolve!: Function
    mock.model.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const host = create(),
      show = host.show()
    await vi.waitFor(() => expect(resolve).toBeDefined())
    await host.hide()
    resolve({
      ok: true,
      data: { model: { id, entry: 'a.model3.json', resources: [] } },
    })
    await show
    expect(mock.windows).toHaveLength(0)
    host.dispose()
  })
  it('blocks external network and unknown app resources', async () => {
    const host = create()
    const result = vi.fn()
    mock.network!({ url: 'https://example.com/a' }, result)
    expect(result).toHaveBeenCalledWith({ cancel: true })
    expect(
      (
        await mock.protocol!({
          url: 'memo-pet://app/secrets.txt',
          method: 'GET',
        })
      ).status,
    ).toBe(404)
    expect(
      (await mock.protocol!({ url: 'memo-pet://app/pet.html', method: 'POST' }))
        .status,
    ).toBe(404)
    host.dispose()
  })
  it('accepts only fixed render error codes and exact selected model', () => {
    expect(
      validPetReport(
        { modelId: id, status: 'error', code: 'RENDER_FAILED' },
        id,
      ),
    ).toBe(true)
    expect(
      validPetReport(
        { modelId: id, status: 'error', code: 'private path' },
        id,
      ),
    ).toBe(false)
    expect(
      validPetReport({ modelId: id, status: 'ready', extra: true }, id),
    ).toBe(false)
  })
})

it('coalesces reads and acknowledges queued presentations without another worker read', async () => {
  let unavailable = false,
    resolveRead: ((v: any) => void) | undefined,
    hold = false
  const reader = vi.fn(async () => {
    if (hold)
      return new Promise((done) => {
        resolveRead = done
      })
    return unavailable
      ? { ok: false, error: 'PET_UNAVAILABLE' }
      : { ok: true, data: { currentModelId: id, models: [], display: false } }
  })
  const host = create(reader)
  await host.show()
  const win = mock.windows[0],
    event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  mock.handlers.get('memo-pet:report')!(event, { modelId: id, status: 'ready' })
  hold = true
  const before = reader.mock.calls.length
  const first = host.state(),
    second = host.state()
  expect(reader.mock.calls.length).toBe(before + 1)
  expect(await host.speak({ text: '已经入队' })).toMatchObject({
    ok: true,
    data: { presentation: { text: '已经入队' } },
  })
  expect(await host.speak({ text: '第二条' })).toMatchObject({ ok: true })
  expect(reader.mock.calls.length).toBe(before + 1)
  resolveRead!({ ok: false, error: 'PET_UNAVAILABLE' })
  expect(await first).toMatchObject({ ok: false })
  expect(await second).toMatchObject({ ok: false })
  hold = false
  unavailable = true
  expect(await host.dismissBubble()).toMatchObject({
    ok: true,
    data: { presentation: { text: '第二条' } },
  })
  expect(await host.speak({ text: '第三条' })).toMatchObject({ ok: true })
  host.dispose()
})

for (const method of ['select', 'remove'] as const)
  it(`${method} returns committed snapshot while an older state waits for runtime`, async () => {
    const oldModel = {
      id,
      entry: 'a.model3.json',
      importedAt: '2026-09-13T00:00:00Z',
      totalBytes: 1,
    }
    const next = {
      currentModelId: null,
      models: method === 'remove' ? [] : [oldModel],
      display: false,
    }
    let finishRuntime!: (value: boolean) => void
    mock.runtime.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finishRuntime = resolve
        }),
    )
    const host = create(
      async () => ({
        ok: true,
        data: { currentModelId: id, models: [oldModel], display: false },
      }),
      { [method]: async () => ({ ok: true, data: next }) },
    )
    const previousRead = host.state()
    await vi.waitFor(() => expect(finishRuntime).toBeDefined())
    const changed =
      method === 'select' ? await host.select(null) : await host.remove(id)
    expect(changed).toMatchObject({ ok: true, data: next })
    finishRuntime(true)
    expect(await previousRead).toMatchObject({ ok: true, data: next })
    host.dispose()
  })
it('a late worker read cannot overwrite a committed model snapshot', async () => {
  let finishRead!: (value: any) => void
  const next = { currentModelId: null, models: [], display: false }
  const host = create(
    () =>
      new Promise((resolve) => {
        finishRead = resolve
      }),
    { remove: async () => ({ ok: true, data: next }) },
  )
  const pending = host.state()
  expect(await host.remove(id)).toMatchObject({ ok: true, data: next })
  finishRead({
    ok: true,
    data: { currentModelId: id, models: [], display: false },
  })
  expect(await pending).toMatchObject({ ok: true, data: next })
  host.dispose()
})

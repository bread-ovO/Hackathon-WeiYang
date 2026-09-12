import { createPresentationQueue } from './presentation-queue'
import { parsePetActionCatalog } from '@memo/contracts'
import {
  BrowserWindow,
  ipcMain,
  screen,
  session,
  type IpcMainInvokeEvent,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  CoreReply,
  PetState,
  PetSpeechPatch,
  PetSpeechState,
} from '@memo/contracts'
import type { createPetImportFlow } from './import-flow'
import type { PetWorkerClient } from './worker-client'
import { createRuntimeStore, safeResourcePath } from './runtime-store'
import { readModelResource, type ModelResourceDescriptor } from './model-route'
import { createPetWindowController, type PetWindowLike } from './pet-window'

export interface PetDesktopDeps {
  worker: Pick<PetWorkerClient, 'request'>
  flow: ReturnType<typeof createPetImportFlow>
  modelRoot: string
  runtimeRoot: string
  rendererRoot: string
  preloadPath: string
  pickRuntimeDirectory(): Promise<string | null>
  devURL?: string
  stateFile?: string
  speechState?(): PetSpeechState | undefined
  configureSpeech?(patch: PetSpeechPatch): Promise<boolean>
  onDisplayChanged?(): void
}
const codes = new Set([
  'RUNTIME_MISSING',
  'MODEL_LOAD_FAILED',
  'MOC3_INVALID',
  'WEBGL_UNAVAILABLE',
  'TEXTURE_INVALID',
  'MOTION_INVALID',
  'PHYSICS_INVALID',
  'SHADER_TIMEOUT',
  'RENDER_FAILED',
])
export function validPetReport(
  value: unknown,
  modelId: string | undefined,
): value is { modelId: string; status: 'ready' | 'error'; code?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return (
    !!modelId &&
    v.modelId === modelId &&
    Object.keys(v).every((k) => ['modelId', 'status', 'code'].includes(k)) &&
    (v.status === 'ready'
      ? v.code === undefined
      : v.status === 'error' && typeof v.code === 'string' && codes.has(v.code))
  )
}
/** Call after app.ready. Register memo-pet privileges before app.ready in the entrypoint. */
export function createPetDesktopController(deps: PetDesktopDeps) {
  const pageURL = deps.devURL
    ? new URL('/pet.html', deps.devURL).href
    : 'memo-pet://app/pet.html'
  const devOrigin = deps.devURL ? new URL(deps.devURL).origin : null
  let installing = false,
    showing: Promise<CoreReply<PetState>> | null = null
  const presentations = createPresentationQueue()
  let catalog: ReturnType<typeof parsePetActionCatalog> = {
    motions: [],
    expressions: [],
  }
  const runtime = createRuntimeStore(deps.runtimeRoot)
  let snapshot: PetState | null = null,
    runtimeReady = false
  let snapshotRevision = 0
  let reading: Promise<CoreReply<PetState>> | null = null
  async function readSnapshot(): Promise<CoreReply<PetState>> {
    if (reading) return reading
    const revision = snapshotRevision
    reading = (async () => {
      const value = await deps.flow.state()
      if (value.ok && !disposed && revision === snapshotRevision)
        snapshot = structuredClone(value.data)
      if (!disposed && revision !== snapshotRevision && snapshot)
        return { ok: true as const, data: structuredClone(snapshot) }
      return value
    })()
    try {
      return await reading
    } finally {
      reading = null
    }
  }

  const isolated = session.fromPartition(`memo-pet-${randomUUID()}`, {
    cache: false,
  })
  let pet: BrowserWindow | null = null,
    descriptor: ModelResourceDescriptor | null = null
  let disposed = false,
    generation = 0,
    renderStatus: NonNullable<PetState['renderStatus']> = 'hidden',
    renderError: string | undefined
  isolated.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  )
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({
      cancel:
        !details.url.startsWith('memo-pet://app/') &&
        !(
          devOrigin &&
          [devOrigin, devOrigin.replace(/^http/, 'ws')].includes(
            new URL(details.url).origin,
          )
        ),
    }),
  )
  isolated.protocol.handle('memo-pet', async (request) => {
    const unavailable = () => new Response(null, { status: 404 })
    try {
      const url = new URL(request.url)
      if (
        disposed ||
        request.method !== 'GET' ||
        url.protocol !== 'memo-pet:' ||
        url.host !== 'app' ||
        url.search ||
        url.hash
      )
        return unavailable()
      const path = decodeURIComponent(url.pathname.slice(1))
      if (!safeResourcePath(path)) return unavailable()
      let resource: { bytes: Uint8Array; mime: string } | null = null
      if (path.startsWith('runtime/'))
        resource = await runtime.read(path.slice(8))
      else if (descriptor && path.startsWith(`models/${descriptor.id}/`)) {
        const selected = descriptor
        resource = await readModelResource(
          deps.modelRoot,
          selected,
          path.slice(`models/${selected.id}/`.length),
        )
        if (descriptor !== selected) return unavailable()
      } else if (
        path === 'pet.html' ||
        /^assets\/[a-zA-Z0-9_-]+\.(?:js|css)$/.test(path)
      ) {
        const target = join(deps.rendererRoot, path),
          stat = await lstat(target)
        if (
          (await realpath(target)) !== resolve(target) ||
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 4 * 1024 * 1024
        )
          return unavailable()
        resource = {
          bytes: await readFile(target),
          mime: path.endsWith('.html')
            ? 'text/html'
            : path.endsWith('.js')
              ? 'text/javascript'
              : 'text/css',
        }
      }
      if (!resource || disposed) return unavailable()
      return new Response(Buffer.from(resource.bytes), {
        headers: {
          ...(devOrigin
            ? { 'Access-Control-Allow-Origin': devOrigin, Vary: 'Origin' }
            : {}),
          'Content-Type': resource.mime,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'",
        },
      })
    } catch {
      return unavailable()
    }
  })
  const windows = createPetWindowController({
    ...(deps.stateFile ? { stateFile: deps.stateFile } : {}),
    hasCurrentModel: async () => {
      const ticket = generation
      if (!(runtimeReady = await runtime.status()))
        throw new Error('PET_RUNTIME_INVALID')
      const state = await readSnapshot()
      if (!state.ok || !state.data.currentModelId) return false
      const model = await deps.worker.request('renderModel', {
        modelId: state.data.currentModelId,
      })
      if (!model.ok) throw new Error('MODEL_LOAD_FAILED')
      if (disposed || ticket !== generation) return false
      descriptor = (model.data as { model: ModelResourceDescriptor }).model
      const selected = descriptor
      const resource = await readModelResource(
        deps.modelRoot,
        selected,
        selected.entry,
      )
      if (disposed || ticket !== generation) return false
      try {
        catalog = resource
          ? parsePetActionCatalog(
              JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                  resource.bytes,
                ),
              ),
            )
          : { motions: [], expressions: [] }
      } catch {
        catalog = { motions: [], expressions: [] }
      }
      renderStatus = 'loading'
      renderError = undefined
      return true
    },
    platform: {
      cursorPosition: () => screen.getCursorScreenPoint(),
      usableArea: (bounds) => {
        const all = screen.getAllDisplays()
        const match =
          bounds &&
          all.find(
            (d) =>
              bounds.x < d.workArea.x + d.workArea.width &&
              bounds.x + bounds.width > d.workArea.x &&
              bounds.y < d.workArea.y + d.workArea.height &&
              bounds.y + bounds.height > d.workArea.y,
          )
        return (match || screen.getPrimaryDisplay()).workArea
      },
      onDisplayChanged: (listener) => {
        screen.on('display-added', listener)
        screen.on('display-removed', listener)
        screen.on('display-metrics-changed', listener)
        return () => {
          screen.removeListener('display-added', listener)
          screen.removeListener('display-removed', listener)
          screen.removeListener('display-metrics-changed', listener)
        }
      },
      createWindow: () => {
        const created = new BrowserWindow({
          width: 320,
          height: 420,
          show: false,
          transparent: true,
          frame: false,
          resizable: false,
          skipTaskbar: true,
          alwaysOnTop: false,
          webPreferences: {
            preload: deps.preloadPath,
            session: isolated,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            backgroundThrottling: true,
          },
        })
        pet = created
        created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        created.webContents.on('will-navigate', (event) =>
          event.preventDefault(),
        )
        created.webContents.on('will-attach-webview', (event) =>
          event.preventDefault(),
        )
        created.webContents.on('render-process-gone', () => {
          if (pet === created) {
            generation++
            descriptor = null
            presentations.clear()
            catalog = { motions: [], expressions: [] }
            renderStatus = 'error'
            renderError = 'RENDER_FAILED'
            windows.rendererGone()
            deps.onDisplayChanged?.()
          }
        })
        created.on('closed', () => {
          if (pet === created) {
            pet = null
            presentations.clear()
            deps.onDisplayChanged?.()
          }
        })
        created.on('moved', () => windows.rememberPosition())
        void created.loadURL(pageURL).catch(() => {
          if (pet === created) {
            descriptor = null
            presentations.clear()
            catalog = { motions: [], expressions: [] }
            renderStatus = 'error'
            renderError = 'RENDER_FAILED'
            windows.rendererGone()
            deps.onDisplayChanged?.()
          }
        })
        return created as unknown as PetWindowLike
      },
    },
  })
  const authorized = (event: IpcMainInvokeEvent) =>
    !disposed &&
    !!pet &&
    !pet.isDestroyed() &&
    event.sender === pet.webContents &&
    event.senderFrame === pet.webContents.mainFrame &&
    event.senderFrame.url === pageURL
  ipcMain.handle('memo-pet:state', (event, ...args: unknown[]) => {
    if (args.length || !authorized(event)) throw new Error('INVALID_PET_SENDER')
    return {
      model: descriptor ? { id: descriptor.id, entry: descriptor.entry } : null,
      visible: windows.displaying(),
      preferences: windows.preferences(),
      presentation: presentations.current(),
      catalog,
    }
  })
  ipcMain.handle(
    'memo-pet:report',
    (event, input: unknown, ...args: unknown[]) => {
      if (
        args.length > 0 ||
        !authorized(event) ||
        !validPetReport(input, descriptor?.id) ||
        !windows.displaying()
      )
        throw new Error('INVALID_PET_REPORT')
      if (input.status === 'ready')
        presentations.bind(`${descriptor!.id}/${generation}`)
      else {
        presentations.clear()
        catalog = { motions: [], expressions: [] }
      }
      renderStatus = input.status
      renderError = input.code
      deps.onDisplayChanged?.()
      if (input.status === 'error') {
        // The fixed SDK does not cancel pending shader fetches. Destroy the
        // failing renderer, keeping its safe error code in the settings state.
        const failed = pet
        setImmediate(() => {
          if (pet !== failed || renderStatus !== 'error') return
          generation++
          descriptor = null
          windows.rendererGone()
        })
      }
    },
  )
  for (const method of ['hitTest', 'drag'] as const)
    ipcMain.handle(
      `memo-pet:${method}`,
      (event, input: unknown, ...args: unknown[]) => {
        if (
          args.length ||
          !authorized(event) ||
          !windows.displaying() ||
          !input ||
          typeof input !== 'object' ||
          Array.isArray(input)
        )
          throw new Error('INVALID_PET_INPUT')
        const value = input as Record<string, unknown>
        if (method === 'hitTest') {
          if (
            Object.keys(value).length !== 1 ||
            typeof value.interactive !== 'boolean'
          )
            throw new Error('INVALID_PET_INPUT')
          windows.hitTest(value.interactive)
        } else {
          if (
            Object.keys(value).length !== 1 ||
            typeof value.phase !== 'string' ||
            !['start', 'move', 'end'].includes(value.phase)
          )
            throw new Error('INVALID_PET_INPUT')
          windows.drag(value.phase as 'start' | 'move' | 'end')
        }
      },
    )
  ipcMain.handle(
    'memo-pet:ack',
    (event, input: unknown, ...args: unknown[]) => {
      if (
        args.length ||
        !authorized(event) ||
        !descriptor ||
        !windows.displaying() ||
        renderStatus !== 'ready' ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input)
      )
        throw new Error('INVALID_PET_ACK')
      const v = input as Record<string, unknown>
      if (
        Object.keys(v).length !== 2 ||
        typeof v.id !== 'string' ||
        (v.status !== 'done' && v.status !== 'unavailable') ||
        !presentations.ack(`${descriptor.id}/${generation}`, v.id)
      )
        throw new Error('INVALID_PET_ACK')
    },
  )
  const enqueue = (input: {
    kind: 'action' | 'bubble'
    text?: string
    actionId?: string
  }) => {
    if (
      disposed ||
      !descriptor ||
      !snapshot ||
      snapshot.currentModelId !== descriptor.id ||
      !windows.displaying() ||
      renderStatus !== 'ready'
    )
      return false
    return presentations.enqueue(
      `${descriptor.id}/${generation}`,
      input,
      new Set(
        [...catalog.motions, ...catalog.expressions].map((item) => item.id),
      ),
    )
  }
  function snapshotReply(): CoreReply<PetState> {
    if (disposed || !snapshot) return { ok: false, error: 'PET_UNAVAILABLE' }
    return {
      ok: true,
      data: {
        ...structuredClone(snapshot),
        display: windows.displaying(),
        preferences: windows.preferences(),
        catalog: structuredClone(catalog),
        presentation: presentations.current(),
        ...(deps.speechState?.() ? { speech: deps.speechState() } : {}),
        runtimeReady,
        renderStatus,
        ...(renderError ? { renderError } : {}),
      },
    }
  }
  let stateReading: Promise<CoreReply<PetState>> | null = null
  async function state(): Promise<CoreReply<PetState>> {
    if (disposed) return { ok: false, error: 'PET_UNAVAILABLE' }
    if (stateReading) return stateReading
    stateReading = (async () => {
      const value = await readSnapshot()
      if (!value.ok) return value
      runtimeReady = await runtime.status()
      return snapshotReply()
    })()
    try {
      return await stateReading
    } finally {
      stateReading = null
    }
  }
  function stop() {
    presentations.clear()
    catalog = { motions: [], expressions: [] }
    generation++
    descriptor = null
    windows.rendererGone()
    renderStatus = 'hidden'
    deps.onDisplayChanged?.()
    renderError = undefined
  }
  return {
    state,
    automaticDisplay() {
      return {
        visible: windows.displaying() && renderStatus === 'ready',
        busy: !!presentations.current(),
      }
    },
    enqueueAutomatic(text: string) {
      if (presentations.current() || !enqueue({ kind: 'bubble', text }))
        return null
      return presentations.current()!.id
    },
    cancelAutomatic(id: string) {
      presentations.cancel(id)
    },
    async configureSpeech(patch: PetSpeechPatch): Promise<CoreReply<PetState>> {
      if (!deps.configureSpeech || !(await deps.configureSpeech(patch)))
        return { ok: false, error: 'INVALID_REQUEST' }
      return state()
    },
    async play(actionId: string): Promise<CoreReply<PetState>> {
      return enqueue({ kind: 'action', actionId })
        ? snapshotReply()
        : { ok: false, error: 'INVALID_REQUEST' }
    },
    async speak(input: {
      text: string
      actionId?: string
    }): Promise<CoreReply<PetState>> {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some((k) => !['text', 'actionId'].includes(k))
      )
        return { ok: false, error: 'INVALID_REQUEST' }
      return enqueue({
        kind: 'bubble',
        text: input.text,
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
      })
        ? snapshotReply()
        : { ok: false, error: 'INVALID_REQUEST' }
    },
    async dismissBubble() {
      if (disposed || !snapshot)
        return { ok: false as const, error: 'PET_UNAVAILABLE' as const }
      presentations.dismissBubble()
      return snapshotReply()
    },
    async configure(patch: {
      scale?: number
      alwaysOnTop?: boolean
      clickThrough?: boolean
    }): Promise<CoreReply<PetState>> {
      if (
        disposed ||
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        !Object.keys(patch).length ||
        Object.keys(patch).some(
          (k) => !['scale', 'alwaysOnTop', 'clickThrough'].includes(k),
        ) ||
        ('scale' in patch &&
          (!Number.isFinite(patch.scale) ||
            patch.scale! < 0.5 ||
            patch.scale! > 2)) ||
        ('alwaysOnTop' in patch && typeof patch.alwaysOnTop !== 'boolean') ||
        ('clickThrough' in patch && typeof patch.clickThrough !== 'boolean')
      )
        return { ok: false, error: 'INVALID_REQUEST' }
      if (patch.scale !== undefined) windows.setScale(patch.scale)
      if (patch.alwaysOnTop !== undefined)
        windows.setAlwaysOnTop(patch.alwaysOnTop)
      if (patch.clickThrough !== undefined)
        windows.setMousePassthrough(patch.clickThrough)
      return state()
    },
    async resetPosition() {
      windows.resetPosition()
      return state()
    },
    async show(): Promise<CoreReply<PetState>> {
      if (installing || disposed) return { ok: false, error: 'PET_UNAVAILABLE' }
      if (showing) return showing
      if (windows.displaying()) return state()
      generation++
      showing = (async () => {
        const result = await windows.show()
        if (!result.ok)
          return {
            ok: false,
            error:
              result.reason === 'no-model'
                ? 'UNKNOWN_MODEL'
                : result.reason === 'unavailable'
                  ? 'PET_RUNTIME_INVALID'
                  : 'PET_UNAVAILABLE',
          }
        return state()
      })()
      try {
        return await showing
      } finally {
        showing = null
      }
    },
    async hide() {
      stop()
      return state()
    },
    async select(id: string | null) {
      stop()
      const reply = await deps.flow.select(id)
      if (!reply.ok) return reply
      snapshotRevision++
      snapshot = structuredClone(reply.data)
      return snapshotReply()
    },
    async remove(id: string) {
      stop()
      const reply = await deps.flow.remove(id)
      if (!reply.ok) return reply
      snapshotRevision++
      snapshot = structuredClone(reply.data)
      return snapshotReply()
    },
    async installRuntime(): Promise<CoreReply<PetState>> {
      if (installing || disposed) return { ok: false, error: 'PET_UNAVAILABLE' }
      installing = true
      stop()
      const ticket = generation
      try {
        const selected = await deps.pickRuntimeDirectory()
        if (disposed || ticket !== generation)
          return { ok: false, error: 'PET_UNAVAILABLE' }
        if (selected) await runtime.install(selected)
        return state()
      } catch {
        return { ok: false, error: 'PET_RUNTIME_INVALID' }
      } finally {
        installing = false
      }
    },
    dispose() {
      if (disposed) return
      presentations.clear()
      catalog = { motions: [], expressions: [] }
      disposed = true
      generation++
      descriptor = null
      windows.dispose()
      ipcMain.removeHandler('memo-pet:state')
      ipcMain.removeHandler('memo-pet:report')
      ipcMain.removeHandler('memo-pet:hitTest')
      ipcMain.removeHandler('memo-pet:drag')
      ipcMain.removeHandler('memo-pet:ack')
      isolated.protocol.unhandle('memo-pet')
      isolated.webRequest.onBeforeRequest(null)
    },
  }
}

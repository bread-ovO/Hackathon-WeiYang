import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  screen,
  session,
  Tray,
  Menu,
  nativeImage,
  dialog,
  powerMonitor,
} from 'electron'
import { join, resolve, sep } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { CoreClient } from './core-client'
import { createPluginRuntime } from './plugin-runtime'
import {
  createCredentialsHandler,
  createSystemCredentialVault,
} from './credentials'
import { saveExportFile } from './export-file'
import type { ExportBundle } from '@memo/storage'
import { isTrustedPage } from './security'
import { createRequestHandler } from './request-handler'
import {
  createCloseToTrayGuard,
  createTrayController,
  electronTrayPlatform,
  type TrayController,
} from './tray'
import { createPetImportFlow } from './pet/import-flow'
import { PetWorkerClient } from './pet/worker-client'
import { createPetWindowController, type PetWindowLike } from './pet/pet-window'
import { resolveModelResource } from './pet/model-route'
import { createSpeechScheduler, type SpeechState } from './pet/speech-scheduler'
import { createBubbleController } from './pet/bubble-window'
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'memo',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])
let window: BrowserWindow | null = null
let core: CoreClient | undefined
let petWorker: PetWorkerClient | undefined
let petWindowControllerRef: ReturnType<typeof createPetWindowController> | undefined
let bubbleControllerRef: ReturnType<typeof createBubbleController> | undefined
let speechTimerRef: ReturnType<typeof setInterval> | undefined
let quitting = false
let choosingSource = false
let savingExport = false
// Inactive until the real controller replaces it after app ready; close events
// before that keep the default quit behavior.
let tray: TrayController = {
  get active() {
    return false
  },
  destroy() {},
}
const trayHost = {
  hideToTray: () => {
    window?.hide()
  },
  restoreWindow: () => {
    if (!window) createWindow()
    else {
      window.show()
      window.focus()
    }
  },
  quitApp: () => {
    quitting = true
    app.quit()
  },
}
// Isolated test data is explicitly opt-in; production never reads this override.
if (!app.isPackaged && process.env.MEMO_TEST_USER_DATA)
  app.setPath('userData', resolve(process.env.MEMO_TEST_USER_DATA))
const devURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const pageURL = devURL || 'memo://app/index.html'
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => trayHost.restoreWindow())
  app
    .whenReady()
    .then(async () => {
      const rendererRoot = resolve(__dirname, '../renderer')
      protocol.handle('memo', async (request) => {
        const url = new URL(request.url)
        if (url.hostname !== 'app')
          return new Response('Forbidden', { status: 403 })
        // PET06: controlled model assets are mapped by id only; the handler
        // never accepts renderer-supplied filesystem paths.
        const modelResource = resolveModelResource(
          decodeURIComponent(url.pathname),
          join(app.getPath('userData'), 'pet-models'),
        )
        if (modelResource) {
          try {
            return await net.fetch(pathToFileURL(modelResource).toString())
          } catch {
            return new Response('Not found', { status: 404 })
          }
        }
        let path: string
        try {
          path = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname))
        } catch {
          return new Response('Bad request', { status: 400 })
        }
        if (!path.startsWith(rendererRoot + sep))
          return new Response('Forbidden', { status: 403 })
        try {
          return await net.fetch(pathToFileURL(path).toString())
        } catch {
          return new Response('Not found', { status: 404 })
        }
      })
      session.defaultSession.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      )
      session.defaultSession.setPermissionCheckHandler(() => false)
      const data = app.getPath('userData')
      mkdirSync(data, { recursive: true })
      core = new CoreClient(
        join(__dirname, 'core.js'),
        join(data, 'memo.sqlite'),
      )
      core.start()
      const vault = createSystemCredentialVault(join(data, 'credentials'))
      const plugins = createPluginRuntime({
        request: (request) =>
          core
            ? core.request(request)
            : Promise.resolve({ ok: false, error: 'CORE_UNAVAILABLE' }),
        readCredential: (id, scope) => vault.read(id, scope),
        choose: async (kind) => {
          if (!window) throw new Error('PLUGIN_UNAVAILABLE')
          const result = await dialog.showOpenDialog(
            window,
            kind === 'manifest'
              ? {
                  title: '选择声明式插件 JSON',
                  properties: ['openFile'],
                  filters: [{ name: '插件 JSON', extensions: ['json'] }],
                }
              : { title: '选择插件授权目录', properties: ['openDirectory'] },
          )
          return result.canceled ? null : (result.filePaths[0] ?? null)
        },
      })
      petWorker = new PetWorkerClient(
        join(__dirname, 'pet-worker.js'),
        join(data, 'pet-models'),
      )
      petWorker.start()
      const petPageURL = devURL ? `${devURL}/pet.html` : 'memo://app/pet.html'
      const bubblePageURL = devURL ? `${devURL}/bubble.html` : 'memo://app/bubble.html'
      let petBrowserWindow: BrowserWindow | null = null
      const petWindow = createPetWindowController({
        platform: {
          createWindow: (): PetWindowLike => {
            const created = new BrowserWindow({
              width: 320,
              height: 420,
              transparent: true,
              frame: false,
              resizable: false,
              skipTaskbar: true,
              hasShadow: false,
              show: false,
              webPreferences: {
                preload: join(__dirname, '../preload/pet.js'),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                webSecurity: true,
              },
            })
            // Same deny posture as the main window; no window.open, no
            // navigation away from the pet page, no webviews.
            created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
            created.webContents.on('will-navigate', (event, url) => {
              if (!isTrustedPage(url, petPageURL)) event.preventDefault()
            })
            created.webContents.on('will-attach-webview', (event) =>
              event.preventDefault(),
            )
            void created.loadURL(petPageURL)
            petBrowserWindow = created
            // BrowserWindow satisfies the structural surface; event listener
            // variance needs this single adapter cast.
            return created as unknown as PetWindowLike
          },
          usableArea: () => screen.getPrimaryDisplay().workArea,
          onDisplayChanged: (listener) => {
            screen.on('display-removed', listener)
            screen.on('display-metrics-changed', listener)
          },
        },
        hasCurrentModel: async () => {
          const reply = await petWorker!.request('list')
          return reply.ok
            ? (reply.data as { currentModelId: string | null })
                .currentModelId !== null
            : false
        },
        stateFile: join(data, 'pet-window.json'),
      })
      let ticking = false
      const pluginTimer = setInterval(() => {
        if (ticking) return
        ticking = true
        void plugins
          .tick()
          .catch(() => {})
          .finally(() => {
            ticking = false
          })
      }, 30_000)
      pluginTimer.unref()
      petWindowControllerRef = petWindow
      // PET09/10/11: proactive speech — bubble window, low-frequency
      // scheduler with injectable clock, lock-screen suppression.
      let bubbleBrowserWindow: BrowserWindow | null = null
      const bubble = createBubbleController({
        createWindow: () => {
          const created = new BrowserWindow({
            width: 280,
            height: 150,
            transparent: true,
            frame: false,
            resizable: false,
            skipTaskbar: true,
            focusable: false,
            show: false,
            parent: petBrowserWindow ?? undefined,
            webPreferences: {
              preload: join(__dirname, '../preload/bubble.js'),
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webSecurity: true,
            },
          })
          created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          void created.loadURL(bubblePageURL)
          bubbleBrowserWindow = created
          return created
        },
        usableArea: () => screen.getPrimaryDisplay().workArea,
        petBounds: () => petBrowserWindow?.getBounds() ?? null,
      })
      bubbleControllerRef = bubble
      ipcMain.on('bubble:close', (event) => {
        const sender = bubbleBrowserWindow?.webContents
        if (sender && event.sender === sender) bubble.dismiss()
      })
      ipcMain.on('bubble:ready', (event) => {
        // The first show may race page load; replay the current text.
        const sender = bubbleBrowserWindow?.webContents
        if (sender && event.sender === sender) bubble.replay()
      })
      const speech = createSpeechScheduler({
        now: () => Date.now(),
        presets: [
          '要不要看看今天还在跟进的事？',
          '有想跟进但还没开始的事吗？慢慢来。',
          '休息一下也可以，我在这里。',
          '今天有新的进展吗？没有也没关系。',
          '别咕太久，记得回头看一眼承诺过的事。',
          '需要我把最近的事项捋一捋吗？',
        ],
        stateFile: join(data, 'pet-speech.json'),
      })
      const speechStateView = (state: SpeechState = speech.state()) => ({
        config: state.config,
        lastSpokeAt: state.lastSpokeAt === null ? null : new Date(state.lastSpokeAt).toISOString(),
        todayCount: state.todayCount,
        nextAt: new Date(state.nextAt).toISOString(),
        suppressed: state.suppressed,
      })
      powerMonitor.on('lock-screen', () => speech.setSuppressed('locked'))
      powerMonitor.on('unlock-screen', () => speech.setSuppressed('none'))
      const speechTimer = setInterval(() => {
        const line = speech.tick()
        if (line) bubble.speak(line)
      }, 30_000)
      speechTimerRef = speechTimer
      ipcMain.on('pet:input', (event, payload: unknown) => {
        // Only the pet window's main frame may drive pass-through or zoom.
        const sender = petBrowserWindow?.webContents
        if (
          !sender ||
          event.sender !== sender ||
          event.senderFrame !== sender.mainFrame ||
          !isTrustedPage(event.senderFrame?.url ?? '', petPageURL)
        )
          return
        const input = payload as { type?: unknown; hit?: unknown; delta?: unknown }
        if (input.type === 'hover' && typeof input.hit === 'boolean')
          petWindow.setMousePassthrough(!input.hit)
        else if (input.type === 'zoom' && typeof input.delta === 'number')
          petWindow.setScale(petWindow.scale() + input.delta)
      })
      ipcMain.handle('pet:runtime:model', async (event) => {
        // Only the pet window's main frame may ask for the current model.
        const sender = petBrowserWindow?.webContents
        if (
          !sender ||
          event.sender !== sender ||
          event.senderFrame !== sender.mainFrame ||
          !isTrustedPage(event.senderFrame?.url ?? '', petPageURL)
        )
          return null
        const reply = await petWorker!.request('list')
        if (!reply.ok) return null
        const snapshot = reply.data as {
          currentModelId: string | null
          models: { id: string; entry: string }[]
        }
        const current = snapshot.models.find(
          (model) => model.id === snapshot.currentModelId,
        )
        return current ? { id: current.id, entry: current.entry } : null
      })
      const petFlow = createPetImportFlow({
        pickDirectory: async () => {
          const result = await dialog.showOpenDialog(window!, {
            title: '选择包含 .model3.json 的模型目录',
            properties: ['openDirectory'],
          })
          // The Electron result always carries filePaths, but stay defensive:
          // anything malformed counts as cancelling, never as a chosen path.
          return result.canceled ||
            !Array.isArray(result.filePaths) ||
            result.filePaths.length !== 1
            ? null
            : result.filePaths[0]!
        },
        worker: petWorker,
      })
      app.once('before-quit', () => {
        clearInterval(pluginTimer)
        plugins.cancel()
      })
      const credentials = createCredentialsHandler(
        join(data, 'credentials'),
        () => window,
        vault,
      )
      ipcMain.handle(
        'memo:request',
        createRequestHandler(
          () => window?.webContents ?? null,
          pageURL,
          async (request) => {
            if (
              request.method === 'plugins.list' ||
              request.method === 'plugins.inspect' ||
              request.method === 'plugins.trial' ||
              request.method === 'plugins.activate' ||
              request.method === 'plugins.disable' ||
              request.method === 'plugins.uninstall' ||
              request.method === 'plugins.sync'
            )
              return plugins.handle(request)
            if (request.method === 'credentials.remove') plugins.cancel()
            if (
              request.method === 'credentials.list' ||
              request.method === 'credentials.importFile' ||
              request.method === 'credentials.remove'
            )
              return credentials(request)
            if (request.method === 'pet.state') {
              const reply = await petFlow.state()
              if (reply.ok) reply.data.display = petWindow.displaying()
              return reply
            }
            if (request.method === 'pet.show') {
              const shown = await petWindow.show()
              return shown.ok
                ? { ok: true as const, data: { display: true } }
                : { ok: false as const, error: 'UNKNOWN_MODEL' as const }
            }
            if (request.method === 'pet.hide') {
              petWindow.hide()
              return { ok: true as const, data: { display: false } }
            }
            if (request.method === 'pet.speechConfig')
              return { ok: true as const, data: speechStateView() }
            if (request.method === 'pet.setSpeechConfig') {
              try {
                const state = speech.configure({
                  ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
                  ...(request.paused !== undefined ? { paused: request.paused } : {}),
                  ...(request.quietStart !== undefined ? { quietStart: request.quietStart } : {}),
                  ...(request.quietEnd !== undefined ? { quietEnd: request.quietEnd } : {}),
                  ...(request.minMinutes !== undefined ? { minMinutes: request.minMinutes } : {}),
                  ...(request.maxMinutes !== undefined ? { maxMinutes: request.maxMinutes } : {}),
                  ...(request.dailyCap !== undefined ? { dailyCap: request.dailyCap } : {}),
                })
                return { ok: true as const, data: speechStateView(state) }
              } catch {
                return { ok: false as const, error: 'INVALID_REQUEST' as const }
              }
            }
            if (request.method === 'pet.previewSpeech') {
              // The bubble belongs next to a visible pet.
              if (!petWindow.displaying())
                return { ok: true as const, data: { shown: false } }
              bubble.speak('要不要看看今天还在跟进的事？')
              return { ok: true as const, data: { shown: bubble.displaying() !== null } }
            }
            if (request.method === 'pet.openImportDialog')
              return petFlow.openImportDialog()
            if (request.method === 'pet.importChosen')
              return petFlow.importChosen(request.entry)
            if (request.method === 'pet.select')
              return petFlow.select(request.modelId)
            if (!core) return { ok: false, error: 'CORE_UNAVAILABLE' }
            if (request.method === 'exports.save') {
              if (!window || savingExport)
                return { ok: false, error: 'CORE_UNAVAILABLE' }
              savingExport = true
              try {
                const selection = await dialog.showSaveDialog(window, {
                  title: '导出事项与证据',
                  defaultPath: `BUGU-export-${new Date().toISOString().slice(0, 10)}.json`,
                  filters: [{ name: 'JSON 导出文件', extensions: ['json'] }],
                  properties: ['createDirectory', 'showOverwriteConfirmation'],
                })
                if (selection.canceled || !selection.filePath)
                  return { ok: true, data: { cancelled: true } }
                const reply = await core.request({
                  ...request,
                  method: 'exports.build',
                })
                if (!reply.ok) return reply
                const bundle = reply.data as ExportBundle
                const saved = await saveExportFile(
                  selection.filePath,
                  JSON.stringify(bundle, null, 2) + '\n',
                )
                return {
                  ok: true,
                  data: {
                    cancelled: false,
                    taskCount: bundle.tasks.length,
                    referenceCount: bundle.events.length,
                    bytes: saved.bytes,
                  },
                }
              } catch (error) {
                return {
                  ok: false,
                  error:
                    error instanceof Error &&
                    error.message === 'EXPORT_LIMIT_EXCEEDED'
                      ? 'EXPORT_LIMIT_EXCEEDED'
                      : 'EXPORT_WRITE_FAILED',
                }
              } finally {
                savingExport = false
              }
            }
            if (request.method === 'sources.chooseFile') {
              if (!window || choosingSource)
                return { ok: false, error: 'CORE_UNAVAILABLE' }
              choosingSource = true
              try {
                const selection = await dialog.showOpenDialog(window, {
                  title: '选择 JSONL 导出文件',
                  properties: ['openFile'],
                  filters: [{ name: 'JSONL 导出', extensions: ['jsonl'] }],
                })
                if (selection.canceled || !selection.filePaths[0]) {
                  const reply = await core.request({ method: 'sources.list' })
                  return reply.ok
                    ? {
                        ok: true,
                        data: { ...(reply.data as object), cancelled: true },
                      }
                    : reply
                }
                return await core.request({
                  method: 'sources.importFile',
                  path: selection.filePaths[0],
                  projectId: request.projectId,
                })
              } finally {
                choosingSource = false
              }
            }
            return core.request(request)
          },
        ),
      )
      tray = createTrayController(
        trayHost,
        electronTrayPlatform({ Tray, Menu, nativeImage }),
      )
      createWindow()
      app.on('activate', () => trayHost.restoreWindow())
    })
    .catch(() => {
      console.error('APP_STARTUP_FAILED')
      app.quit()
    })
  // Without a tray there is nothing to restore from, so keep the classic behavior.
  app.on('window-all-closed', () => {
    if (!tray.active && process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => {
    quitting = true
    clearInterval(speechTimerRef)
    bubbleControllerRef?.dispose()
    petWindowControllerRef?.dispose()
    petWorker?.stop()
    core?.stop()
  })
  app.on('will-quit', () => tray.destroy())
}
function createWindow() {
  window = new BrowserWindow({
    width: 1140,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    title: 'BUGU 不咕',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#faf9f6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedPage(url, pageURL)) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) =>
    event.preventDefault(),
  )
  window.on(
    'close',
    createCloseToTrayGuard(() => tray.active && !quitting, trayHost.hideToTray),
  )
  window.on('closed', () => {
    window = null
  })
  void window.loadURL(pageURL)
}

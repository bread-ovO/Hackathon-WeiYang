import { createFeishuRuntime } from './feishu-runtime'
import { createGithubRuntime } from './github-runtime'
import { createPetSpeechService } from './pet/speech-service'
import { createPetSpeechStore } from './pet/speech-store'
import { createPetSpeechEnvironment } from './pet/speech-environment'
import { createPetDesktopController } from './pet/desktop-controller'
import { PetWorkerClient } from './pet/worker-client'
import { createPetImportFlow } from './pet/import-flow'
import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  session,
  Tray,
  Menu,
  nativeImage,
  dialog,
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
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'memo-pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'memo',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])
let window: BrowserWindow | null = null
let core: CoreClient | undefined
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
      protocol.handle('memo', (request) => {
        const url = new URL(request.url)
        if (url.hostname !== 'app')
          return new Response('Forbidden', { status: 403 })
        let path: string
        try {
          path = resolve(rendererRoot, '.' + decodeURIComponent(url.pathname))
        } catch {
          return new Response('Bad request', { status: 400 })
        }
        if (!path.startsWith(rendererRoot + sep))
          return new Response('Forbidden', { status: 403 })
        return net.fetch(pathToFileURL(path).toString())
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
      const petWorker = new PetWorkerClient(
        join(__dirname, 'pet-worker.js'),
        join(data, 'pet-models'),
      )
      petWorker.start()
      const pets = createPetImportFlow({
        worker: petWorker,
        pickDirectory: async () => {
          if (!window) return null
          const choice = await dialog.showOpenDialog(window, {
            title: '选择 Live2D 模型目录',
            properties: ['openDirectory'],
          })
          return choice.canceled ? null : (choice.filePaths[0] ?? null)
        },
      })
      let speech: ReturnType<typeof createPetSpeechService> | undefined
      const environment = createPetSpeechEnvironment({
        helperPath: join(
          __dirname.replace('app.asar', 'app.asar.unpacked'),
          '../native/pet-speech-environment',
        ),
        onChange: () => {
          void speech?.wake()
        },
      })
      const petDesktop = createPetDesktopController({
        speechState: () => speech?.snapshot(),
        configureSpeech: (patch) =>
          speech?.configure(patch) ?? Promise.resolve(false),
        onDisplayChanged: () => {
          void speech?.wake()
        },
        worker: petWorker,
        flow: pets,
        stateFile: join(data, 'pet-window.json'),
        ...(devURL ? { devURL } : {}),
        modelRoot: join(data, 'pet-models'),
        runtimeRoot: join(data, 'pet-runtime'),
        rendererRoot,
        preloadPath: join(__dirname, '../preload/pet.js'),
        pickRuntimeDirectory: async () => {
          if (!window) return null
          const choice = await dialog.showOpenDialog(window, {
            title: '选择 Live2D 运行库目录',
            properties: ['openDirectory'],
          })
          return choice.canceled ? null : (choice.filePaths[0] ?? null)
        },
      })
      speech = createPetSpeechService({
        store: createPetSpeechStore(join(data, 'pet-speech.json')),
        environment: () => environment.read(),
        monitor: (enabled) => environment.setEnabled(enabled),
        display: () => petDesktop.automaticDisplay(),
        deliver: (text) => petDesktop.enqueueAutomatic(text),
        cancel: (id) => petDesktop.cancelAutomatic(id),
      })
      app.once('before-quit', () => {
        speech?.dispose()
        environment.dispose()
        petDesktop.dispose()
        petWorker.stop()
      })
      const vault = createSystemCredentialVault(join(data, 'credentials'))
      const feishu = createFeishuRuntime({
        request: (request) =>
          core
            ? core.request(request)
            : Promise.resolve({ ok: false, error: 'CORE_UNAVAILABLE' }),
        readCredential: (id, scope) => vault.read(id, scope),
      })
      const feishuTimer = setInterval(() => {
        void feishu.tick().catch(() => {})
      }, 1000)
      feishuTimer.unref()
      app.once('before-quit', () => {
        clearInterval(feishuTimer)
        feishu.stop()
      })
      const github = createGithubRuntime({
        request: (request) =>
          core
            ? core.request(request)
            : Promise.resolve({ ok: false, error: 'CORE_UNAVAILABLE' }),
        readCredential: (id, scope) => vault.read(id, scope),
      })
      const githubTimer = setInterval(() => {
        void github.tick().catch(() => {})
      }, 1000)
      githubTimer.unref()
      app.once('before-quit', () => {
        clearInterval(githubTimer)
        github.stop()
      })
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
            if (request.method === 'pet.configureSpeech')
              return petDesktop.configureSpeech(request.patch)
            if (request.method === 'pet.play')
              return petDesktop.play(request.actionId)
            if (request.method === 'pet.speak')
              return petDesktop.speak(request.input)
            if (request.method === 'pet.dismissBubble')
              return petDesktop.dismissBubble()
            if (request.method === 'pet.configure')
              return petDesktop.configure(request.patch)
            if (request.method === 'pet.resetPosition')
              return petDesktop.resetPosition()
            if (request.method === 'pet.state') return petDesktop.state()
            if (request.method === 'pet.show') return petDesktop.show()
            if (request.method === 'pet.hide') return petDesktop.hide()
            if (request.method === 'pet.installRuntime')
              return petDesktop.installRuntime()
            if (request.method === 'pet.openImportDialog')
              return pets.openImportDialog()
            if (request.method === 'pet.cancelImport')
              return pets.cancelImport()
            if (request.method === 'pet.importChosen')
              return pets.importChosen(request.sessionId, request.entry)
            if (request.method === 'pet.select')
              return petDesktop.select(request.modelId)
            if (request.method === 'pet.remove')
              return petDesktop.remove(request.modelId)
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
            if (
              request.method === 'github.list' ||
              request.method === 'github.connect' ||
              request.method === 'github.setEnabled' ||
              request.method === 'github.revoke' ||
              request.method === 'github.sync' ||
              request.method === 'github.records'
            )
              return github.handle(request)
            if (
              request.method === 'feishu.list' ||
              request.method === 'feishu.connect' ||
              request.method === 'feishu.sync' ||
              request.method === 'feishu.records' ||
              request.method === 'feishu.setEnabled' ||
              request.method === 'feishu.revoke' ||
              request.method === 'feishu.restartWindow'
            )
              return feishu.handle(request)
            if (request.method === 'credentials.remove') {
              plugins.cancel()
              return github.removeCredential(request.id, () =>
                feishu.removeCredential(request.id, () => credentials(request)),
              )
            }
            if (
              request.method === 'credentials.list' ||
              request.method === 'credentials.importFile'
            )
              return credentials(request)
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

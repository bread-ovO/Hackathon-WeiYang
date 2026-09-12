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

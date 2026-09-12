// Isolated compatibility fixture; never use an existing Electron profile.
const { app, BrowserWindow, session } = require('electron')
const { mkdirSync, realpathSync } = require('node:fs')
const { join, isAbsolute } = require('node:path')
const profile = process.env.PET_VERIFY_PROFILE
const page = process.env.PET_VERIFY_URL
if (!profile || !isAbsolute(profile) || realpathSync(profile) !== profile)
  throw new Error('INVALID_TEST_PROFILE')
const url = new URL(page)
if (
  url.protocol !== 'http:' ||
  url.hostname !== '127.0.0.1' ||
  !url.port ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  !['/verify-strict.html', '/verify-wasm.html'].includes(url.pathname)
)
  throw new Error('INVALID_TEST_URL')
const sessionData = join(profile, 'session')
mkdirSync(sessionData, { recursive: true })
app.setPath('userData', profile)
app.setPath('sessionData', sessionData)
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) =>
    cb(false),
  )
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      callback({ cancel: new URL(details.url).origin !== url.origin })
    } catch {
      callback({ cancel: true })
    }
  })
  const win = new BrowserWindow({
    width: 560,
    height: 600,
    show: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => {
    if (target !== page) event.preventDefault()
  })
  win.webContents.on('will-redirect', (event) => event.preventDefault())
  win.loadURL(page)
})
app.on('window-all-closed', () => app.quit())

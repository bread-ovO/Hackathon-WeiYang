// PET01 fixture: an Electron main that mirrors the production window's
// security posture (sandbox, contextIsolation, no Node, denied permissions)
// and loads the verification page from the local HTTP server started by the
// spec. Never packaged with the app.
const { app, BrowserWindow, session } = require('electron')

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
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
  win.loadURL(process.env.PET_VERIFY_URL)
})

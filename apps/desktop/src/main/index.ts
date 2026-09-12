import { app, BrowserWindow, ipcMain, protocol, net, session, Tray, Menu, nativeImage } from 'electron'
import { join, resolve, sep } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseCoreRequest, type CoreReply } from '@memo/contracts'
import { CoreClient } from './core-client'
import { isTrustedPage } from './security'
import { createCloseToTrayGuard, createTrayController, electronTrayPlatform } from './tray'
protocol.registerSchemesAsPrivileged([{scheme:'memo',privileges:{standard:true,secure:true,supportFetchAPI:true}}])
let window:BrowserWindow|null=null
let core:CoreClient|undefined
let quitting=false
// Isolated test data is explicitly opt-in; production never reads this override.
if (!app.isPackaged && process.env.MEMO_TEST_USER_DATA) app.setPath('userData',resolve(process.env.MEMO_TEST_USER_DATA))
const devURL=!app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const pageURL=devURL || 'memo://app/index.html'
if (!app.requestSingleInstanceLock()) app.quit()
else {
 app.on('second-instance',()=>{window?.show();window?.focus()})
 app.whenReady().then(async()=>{
   const rendererRoot=resolve(__dirname,'../renderer')
   protocol.handle('memo',(request)=>{
     const url=new URL(request.url)
     if(url.hostname!=='app') return new Response('Forbidden',{status:403})
     let path:string
     try {path=resolve(rendererRoot,'.'+decodeURIComponent(url.pathname))} catch {return new Response('Bad request',{status:400})}
     if(!path.startsWith(rendererRoot+sep)) return new Response('Forbidden',{status:403})
     return net.fetch(pathToFileURL(path).toString())
   })
   session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false))
   session.defaultSession.setPermissionCheckHandler(()=>false)
   const data=app.getPath('userData');mkdirSync(data,{recursive:true})
   core=new CoreClient(join(__dirname,'core.js'),join(data,'memo.sqlite'));core.start()
   ipcMain.handle('memo:request',async(event,input:unknown):Promise<CoreReply>=>{
     if (!window || event.sender!==window.webContents || event.senderFrame!==window.webContents.mainFrame || !isTrustedPage(event.senderFrame.url,pageURL)) return {ok:false,error:'INVALID_REQUEST'}
     try {return await core!.request(parseCoreRequest(input))} catch {return {ok:false,error:'INVALID_REQUEST'}}
   })
   const createWindow=()=>{
     window=new BrowserWindow({width:1140,height:780,minWidth:860,minHeight:620,title:'BUGU 不咕',titleBarStyle:'hiddenInset',trafficLightPosition:{x:16,y:18},backgroundColor:'#faf9f6',webPreferences:{preload:join(__dirname,'../preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true}})
     window.webContents.setWindowOpenHandler(()=>({action:'deny'}))
     window.webContents.on('will-navigate',(event,url)=>{if(!isTrustedPage(url,pageURL))event.preventDefault()})
     window.webContents.on('will-attach-webview',event=>event.preventDefault())
     window.on('close',createCloseToTrayGuard(()=>quitting,trayHost))
     window.on('closed',()=>{window=null})
     void window.loadURL(pageURL)
   }
   const trayHost={
    hideToTray:()=>{window?.hide()},
    restoreWindow:()=>{if(!window)createWindow();else{window.show();window.focus()}},
    quitApp:()=>{quitting=true;app.quit()}
   }
   createTrayController(trayHost,electronTrayPlatform({Tray,Menu,nativeImage}))
   createWindow()
   app.on('activate',()=>trayHost.restoreWindow())
 }).catch(()=>{console.error('APP_STARTUP_FAILED');app.quit()})
 app.on('before-quit',()=>{quitting=true;core?.stop()})
}

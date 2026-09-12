import {describe,it,expect} from 'vitest'
import {createCloseToTrayGuard,createTrayController,type TrayHost,type TrayPlatform,type TrayTemplateItem} from '../../apps/desktop/src/main/tray'
interface FakeTray { tooltip:string; menu:TrayTemplateItem[]|undefined; click:()=>void; destroyCount:number }
function makePlatform(){
 const tray:FakeTray={tooltip:'',menu:undefined,click:()=>{},destroyCount:0}
 const images:string[]=[]
 const platform:TrayPlatform={
  createImage:dataUrl=>{images.push(dataUrl);return {dataUrl}},
  createTray:()=>({
   setToolTip:tip=>{tray.tooltip=tip},
   setContextMenu:menu=>{tray.menu=menu as TrayTemplateItem[]},
   on:(event,listener)=>{if(event==='click')tray.click=listener},
   destroy:()=>{tray.destroyCount++},
  }),
  buildFromTemplate:template=>template,
 }
 return {tray,images,platform}
}
function makeHost(){
 const calls:string[]=[]
 const host:TrayHost={
  hideToTray:()=>{calls.push('hide')},
  restoreWindow:()=>{calls.push('restore')},
  quitApp:()=>{calls.push('quit')},
 }
 return {calls,host}
}
describe('tray controller',()=>{
 it('embeds a bundled icon and keeps a tooltip',()=>{
  const {tray,images,platform}=makePlatform()
  const {host}=makeHost()
  createTrayController(host,platform)
  expect(images).toHaveLength(1)
  expect(images[0]!.startsWith('data:image/png;base64,')).toBe(true)
  expect(tray.tooltip).toBe('BUGU 不咕')
 })
 it('restores the window on tray click and via the menu item',()=>{
  const {tray,platform}=makePlatform()
  const {calls,host}=makeHost()
  createTrayController(host,platform)
  tray.click()
  tray.menu!.find(item=>item.label==='显示主窗口')!.click!()
  expect(calls).toEqual(['restore','restore'])
 })
 it('quits only through the explicit menu item',()=>{
  const {tray,platform}=makePlatform()
  const {calls,host}=makeHost()
  createTrayController(host,platform)
  tray.menu!.find(item=>item.label==='退出 BUGU 不咕')!.click!()
  expect(calls).toEqual(['quit'])
 })
 it('destroys the tray exactly once',()=>{
  const {tray,platform}=makePlatform()
  const {host}=makeHost()
  const controller=createTrayController(host,platform)
  expect(tray.destroyCount).toBe(0)
  controller.destroy();controller.destroy()
  expect(tray.destroyCount).toBe(1)
 })
})
describe('close-to-tray guard',()=>{
 it('blocks window close and hides to tray while running',()=>{
  const {calls,host}=makeHost()
  let prevented=0
  createCloseToTrayGuard(()=>false,host)({preventDefault:()=>{prevented++}})
  expect(prevented).toBe(1)
  expect(calls).toEqual(['hide'])
 })
 it('lets the window close during quit',()=>{
  const {calls,host}=makeHost()
  let prevented=0
  createCloseToTrayGuard(()=>true,host)({preventDefault:()=>{prevented++}})
  expect(prevented).toBe(0)
  expect(calls).toEqual([])
 })
})

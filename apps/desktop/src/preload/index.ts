import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '@memo/contracts'
const bridge:DesktopBridge = {
  health:()=>ipcRenderer.invoke('memo:request',{method:'health'}),
  resumeSource:(sourceId)=>ipcRenderer.invoke('memo:request',{method:'resumeSource',sourceId}),
  updateCapacity:(limits)=>ipcRenderer.invoke('memo:request',{method:'updateCapacity',limits}),
}
contextBridge.exposeInMainWorld('memo',Object.freeze(bridge))

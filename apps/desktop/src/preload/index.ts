import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '@memo/contracts'
const bridge:DesktopBridge = {health:()=>ipcRenderer.invoke('memo:request',{method:'health'})}
contextBridge.exposeInMainWorld('memo',Object.freeze(bridge))

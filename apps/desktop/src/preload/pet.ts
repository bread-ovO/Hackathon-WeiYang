import { contextBridge, ipcRenderer } from 'electron'
// PET08: the pet renderer reports hover hit-tests and zoom intents only.
// No request/response surface, no Node, no file access — validated by the
// sender check in the main process before any state changes.
const bridge = Object.freeze({
  hover: (hit: boolean) => ipcRenderer.send('pet:input', { type: 'hover', hit }),
  zoom: (delta: number) => ipcRenderer.send('pet:input', { type: 'zoom', delta }),
})
contextBridge.exposeInMainWorld('petInput', bridge)
export type PetInputBridge = typeof bridge

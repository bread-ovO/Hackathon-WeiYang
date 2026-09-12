import { contextBridge, ipcRenderer } from 'electron'
// PET08: the pet renderer reports hover hit-tests and zoom intents only.
// PET06: runtime asks for the current controlled model — no paths cross.
// No request/response surface beyond these, no Node, no file access.
const bridge = Object.freeze({
  hover: (hit: boolean) => ipcRenderer.send('pet:input', { type: 'hover', hit }),
  zoom: (delta: number) => ipcRenderer.send('pet:input', { type: 'zoom', delta }),
  model: () => ipcRenderer.invoke('pet:runtime:model'),
})
contextBridge.exposeInMainWorld('petInput', bridge)
export type PetInputBridge = typeof bridge

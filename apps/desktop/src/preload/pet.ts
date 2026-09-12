import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld(
  'petInput',
  Object.freeze({
    hitTest: (input: { interactive: boolean }) =>
      ipcRenderer.invoke('memo-pet:hitTest', input),
    drag: (input: { phase: 'start' | 'move' | 'end' }) =>
      ipcRenderer.invoke('memo-pet:drag', input),
    ack: (input: { id: string; status: 'done' | 'unavailable' }) =>
      ipcRenderer.invoke('memo-pet:ack', input),
    state: () => ipcRenderer.invoke('memo-pet:state'),
    report: (input: {
      modelId: string
      status: 'ready' | 'error'
      code?: string
    }) => ipcRenderer.invoke('memo-pet:report', input),
  }),
)

import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld(
  'petInput',
  Object.freeze({
    state: () => ipcRenderer.invoke('memo-pet:state'),
    report: (input: {
      modelId: string
      status: 'ready' | 'error'
      code?: string
    }) => ipcRenderer.invoke('memo-pet:report', input),
  }),
)

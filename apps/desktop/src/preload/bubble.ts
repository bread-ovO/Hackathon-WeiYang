import { contextBridge, ipcRenderer } from 'electron'
// PET09: the bubble renderer only receives text and reports dismissal.
contextBridge.exposeInMainWorld(
  'bubble',
  Object.freeze({
    onShow: (handler: (text: string) => void) => {
      ipcRenderer.on('bubble:show', (_event, payload: unknown) => {
        if (
          payload &&
          typeof payload === 'object' &&
          typeof (payload as { text?: unknown }).text === 'string'
        )
          handler((payload as { text: string }).text)
      })
    },
    // The renderer may finish loading after the first show message raced it.
    ready: () => ipcRenderer.send('bubble:ready'),
    close: () => ipcRenderer.send('bubble:close'),
  }),
)

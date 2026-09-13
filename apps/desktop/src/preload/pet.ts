import { contextBridge, ipcRenderer } from 'electron'
contextBridge.exposeInMainWorld(
  'petInput',
  Object.freeze({
    voiceAudio: (input:{id:string;version:number})=>ipcRenderer.invoke('memo-pet:voiceAudio',input),
    voiceReport: (input:{id:string;version:number;status:'playing'|'ended'|'error'})=>ipcRenderer.invoke('memo-pet:voiceReport',input),
    onVoiceStop: (callback:()=>void)=>{const listener=()=>callback();ipcRenderer.on('memo-pet:voiceStop',listener);return()=>ipcRenderer.removeListener('memo-pet:voiceStop',listener)},
    openContext: (input: { id: string }) =>
      ipcRenderer.invoke('memo-pet:openContext', input),
    hitTest: (input: { interactive: boolean }) =>
      ipcRenderer.invoke('memo-pet:hitTest', input),
    drag: (input: { phase: 'start' | 'move' | 'end' }) =>
      ipcRenderer.invoke('memo-pet:drag', input),
    ack: (input: { id: string; status: 'done' | 'unavailable' }) =>
      ipcRenderer.invoke('memo-pet:ack', input),
    state: () => ipcRenderer.invoke('memo-pet:state'),
    report: (input: {
      modelId: string
      status: 'ready' | 'recovering' | 'error'
      code?: string
    }) => ipcRenderer.invoke('memo-pet:report', input),
  }),
)

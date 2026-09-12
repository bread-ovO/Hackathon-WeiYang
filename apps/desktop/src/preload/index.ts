import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '@memo/contracts'
const bridge: DesktopBridge = {
  health: () => ipcRenderer.invoke('memo:request', { method: 'health' }),
  workspace: Object.freeze({
    list: (query) =>
      ipcRenderer.invoke('memo:request', {
        method: 'workspace.list',
        ...(query === undefined ? {} : { query }),
      }),
    detail: (projectId, id, criteriaVersion) =>
      ipcRenderer.invoke('memo:request', {
        method: 'workspace.detail',
        projectId,
        id,
        ...(criteriaVersion === undefined ? {} : { criteriaVersion }),
      }),
    replaceCriteria: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.replaceCriteria',
      }),
    createProject: (name: string) =>
      ipcRenderer.invoke('memo:request', {
        method: 'workspace.createProject',
        name,
      }),
    createTask: (projectId: string, title: string) =>
      ipcRenderer.invoke('memo:request', {
        method: 'workspace.createTask',
        projectId,
        title,
      }),
    updateTask: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.updateTask',
      }),
  }),
}
contextBridge.exposeInMainWorld('memo', Object.freeze(bridge))

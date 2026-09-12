import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '@memo/contracts'
const bridge: DesktopBridge = {
  health: () => ipcRenderer.invoke('memo:request', { method: 'health' }),
  exports: Object.freeze({
    save: (scope) =>
      ipcRenderer.invoke('memo:request', { ...scope, method: 'exports.save' }),
  }),
  sources: Object.freeze({
    list: () => ipcRenderer.invoke('memo:request', { method: 'sources.list' }),
    chooseFile: (projectId) =>
      ipcRenderer.invoke('memo:request', {
        method: 'sources.chooseFile',
        projectId,
      }),
    sync: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'sources.sync', id }),
    revoke: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'sources.revoke', id }),
  }),
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
  pet: Object.freeze({
    state: () => ipcRenderer.invoke('memo:request', { method: 'pet.state' }),
    openImportDialog: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.openImportDialog' }),
    importChosen: (entry: string) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.importChosen', entry }),
    select: (modelId: string) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.select', modelId }),
    show: () => ipcRenderer.invoke('memo:request', { method: 'pet.show' }),
    hide: () => ipcRenderer.invoke('memo:request', { method: 'pet.hide' }),
    speechConfig: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.speechConfig' }),
    setSpeechConfig: (patch: Record<string, unknown>) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.setSpeechConfig', ...patch }),
    previewSpeech: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.previewSpeech' }),
  }),
}
contextBridge.exposeInMainWorld('memo', Object.freeze(bridge))

import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '@memo/contracts'
const bridge: DesktopBridge = {
  health: () => ipcRenderer.invoke('memo:request', { method: 'health' }),
  plugins: Object.freeze({
    list: () => ipcRenderer.invoke('memo:request', { method: 'plugins.list' }),
    inspect: () =>
      ipcRenderer.invoke('memo:request', { method: 'plugins.inspect' }),
    trial: (input) =>
      ipcRenderer.invoke('memo:request', { ...input, method: 'plugins.trial' }),
    activate: (trialId) =>
      ipcRenderer.invoke('memo:request', {
        method: 'plugins.activate',
        trialId,
      }),
    disable: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'plugins.disable', id }),
    uninstall: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'plugins.uninstall', id }),
    sync: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'plugins.sync', id }),
  }),
  credentials: Object.freeze({
    list: () =>
      ipcRenderer.invoke('memo:request', { method: 'credentials.list' }),
    importFile: (input) =>
      ipcRenderer.invoke('memo:request', {
        ...input,
        method: 'credentials.importFile',
      }),
    remove: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'credentials.remove', id }),
  }),
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
}
contextBridge.exposeInMainWorld('memo', Object.freeze(bridge))

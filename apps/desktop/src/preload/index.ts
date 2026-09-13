import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge } from '@memo/contracts'
const bridge: DesktopBridge = {
  onOpenTask(callback) {
    const listener = (_event: unknown, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const v = value as Record<string, unknown>
      if (
        Object.keys(v).sort().join(',') !== 'projectId,taskId' ||
        [v.projectId, v.taskId].some(
          (x) =>
            typeof x !== 'string' ||
            !x.length ||
            x.length > 256 ||
            /[\s\u0000-\u001f\u007f]/u.test(x),
        )
      )
        return
      callback({ projectId: v.projectId as string, taskId: v.taskId as string })
    }
    ipcRenderer.on('memo:open-task', listener)
    return () => ipcRenderer.removeListener('memo:open-task', listener)
  },
  feishu: Object.freeze({
    list: () => ipcRenderer.invoke('memo:request', { method: 'feishu.list' }),
    connect: (input) =>
      ipcRenderer.invoke('memo:request', {
        ...input,
        method: 'feishu.connect',
      }),
    setEnabled: (id, enabled) =>
      ipcRenderer.invoke('memo:request', {
        method: 'feishu.setEnabled',
        id,
        enabled,
      }),
    revoke: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'feishu.revoke', id }),
    sync: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'feishu.sync', id }),
    restartWindow: (id) =>
      ipcRenderer.invoke('memo:request', {
        method: 'feishu.restartWindow',
        id,
      }),
    records: (input) =>
      ipcRenderer.invoke('memo:request', {
        ...input,
        method: 'feishu.records',
      }),
  }),
  github: Object.freeze({
    list: () => ipcRenderer.invoke('memo:request', { method: 'github.list' }),
    connect: (input) =>
      ipcRenderer.invoke('memo:request', {
        ...input,
        method: 'github.connect',
      }),
    setEnabled: (id, enabled) =>
      ipcRenderer.invoke('memo:request', {
        method: 'github.setEnabled',
        id,
        enabled,
      }),
    revoke: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'github.revoke', id }),
    sync: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'github.sync', id }),
    records: (input) =>
      ipcRenderer.invoke('memo:request', {
        ...input,
        method: 'github.records',
      }),
  }),
  pet: Object.freeze({
    contextState: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.contextState' }),
    configureContext: (input) =>
      ipcRenderer.invoke('memo:request', {
        ...input,
        method: 'pet.configureContext',
      }),
    previewContext: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.previewContext' }),
    cancelContext: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.cancelContext' }),
    showContext: (id) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.showContext', id }),
    configureSpeech: (patch) =>
      ipcRenderer.invoke('memo:request', {
        method: 'pet.configureSpeech',
        patch,
      }),
    play: (actionId) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.play', actionId }),
    speak: (input) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.speak', input }),
    dismissBubble: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.dismissBubble' }),
    configure: (patch) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.configure', patch }),
    resetPosition: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.resetPosition' }),
    show: () => ipcRenderer.invoke('memo:request', { method: 'pet.show' }),
    hide: () => ipcRenderer.invoke('memo:request', { method: 'pet.hide' }),
    installRuntime: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.installRuntime' }),
    state: () => ipcRenderer.invoke('memo:request', { method: 'pet.state' }),
    openImportDialog: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.openImportDialog' }),
    cancelImport: () =>
      ipcRenderer.invoke('memo:request', { method: 'pet.cancelImport' }),
    importChosen: (sessionId, entry) =>
      ipcRenderer.invoke('memo:request', {
        method: 'pet.importChosen',
        sessionId,
        entry,
      }),
    select: (modelId) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.select', modelId }),
    remove: (modelId) =>
      ipcRenderer.invoke('memo:request', { method: 'pet.remove', modelId }),
  }),
  ingestion: Object.freeze({
    status: () =>
      ipcRenderer.invoke('memo:request', { method: 'ingestion.status' }),
    configure: (patch) =>
      ipcRenderer.invoke('memo:request', {
        method: 'ingestion.configure',
        patch,
      }),
  }),
  processing: Object.freeze({
    status: () =>
      ipcRenderer.invoke('memo:request', { method: 'processing.status' }),
    configure: (enabled) =>
      ipcRenderer.invoke('memo:request', {
        method: 'processing.configure',
        enabled,
      }),
  }),
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
    sourceEvents: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.sourceEvents',
      }),
    sourceBindings: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.sourceBindings',
      }),
    bindSourceObject: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.bindSourceObject',
      }),
    revokeSourceBinding: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.revokeSourceBinding',
      }),
    identityMappings: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.identityMappings',
      }),
    confirmIdentityMapping: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.confirmIdentityMapping',
      }),
    revokeIdentityMapping: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.revokeIdentityMapping',
      }),

    reevaluatePlanChange: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.reevaluatePlanChange',
      }),
    planChanges: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.planChanges',
      }),
    confirmPlanChange: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.confirmPlanChange',
      }),
    timeline: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.timeline',
      }),
    listReferences: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.listReferences',
      }),
    reviewReference: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.reviewReference',
      }),
    confirmReference: (request) =>
      ipcRenderer.invoke('memo:request', {
        ...request,
        method: 'workspace.confirmReference',
      }),
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

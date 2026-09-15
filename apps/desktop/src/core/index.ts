import { createTaskChatService } from './task-chat'
import { createTaskModelBridge } from './task-model-bridge'
import { handleFeishuHost, isFeishuHostRequest } from './feishu'
import { handleGithubHost, isGithubHostRequest } from './github'
import { handlePluginHost } from './plugins'
import { createSourceHandler } from './sources'
import { handleWorkspace } from './workspace'
import { createLocalProcessing } from './processing'
import { createTaskAnalysisService } from './task-analysis'
import { openStore } from '@memo/storage'
import { parseHostRequest, type CoreReply } from '@memo/contracts'
const parentPort = (
  process as unknown as {
    parentPort: {
      on(event: 'message', listener: (event: { data: unknown }) => void): void
      postMessage(data: unknown): void
    }
  }
).parentPort
const path = process.argv[2]
if (!path || !parentPort) throw new Error('CORE_STARTUP_INVALID')
const store = openStore(path)
const sources = createSourceHandler(store)
const processing = createLocalProcessing(store)
const modelBridge = createTaskModelBridge(parentPort)
const analysis = createTaskAnalysisService(store, modelBridge)
const chat = createTaskChatService(store, modelBridge)
analysis.start()
parentPort.on('message', async ({ data }) => {
  if (
    !data ||
    typeof data !== 'object' ||
    !('id' in data) ||
    !('request' in data) ||
    typeof data.id !== 'string'
  )
    return
  let reply: CoreReply<unknown>
  try {
    const request = parseHostRequest(data.request)
    if (request.method === 'processing.configure' && !request.enabled) analysis.cancel()
    if (request.method.startsWith('pet.')) throw new Error('INVALID_REQUEST')
    reply = {
      ok: true,
      data: request.method === 'chat.status' || request.method === 'chat.send' || request.method === 'chat.confirm' || request.method === 'chat.cancel' || request.method === 'chat.reject'
        ? chat.handle(request)
        : request.method === 'analysis.start' || request.method === 'analysis.status' || request.method === 'analysis.accept'
        ? analysis.handle(request)
        : isFeishuHostRequest(request)
        ? handleFeishuHost(store, request)
        : isGithubHostRequest(request)
          ? handleGithubHost(store, request)
          : request.method === 'ingestion.status'
            ? store.ingestion.getStatus()
            : request.method === 'ingestion.configure'
              ? store.ingestion.configure(request.patch)
              : request.method === 'processing.status'
                ? processing.status()
                : request.method === 'processing.configure'
                  ? processing.configure(request.enabled)
                  : request.method === 'pluginHost.list' ||
                      request.method === 'pluginHost.get' ||
                      request.method === 'pluginHost.activate' ||
                      request.method === 'pluginHost.disable' ||
                      request.method === 'pluginHost.uninstall' ||
                      request.method === 'pluginHost.receiveBatch' ||
                      request.method === 'pluginHost.recordError'
                    ? handlePluginHost(store, request)
                    : request.method === 'exports.build'
                      ? store.exports.build(request)
                      : request.method === 'health'
                        ? store.health()
                        : request.method === 'sources.list' ||
                            request.method === 'sources.importFile' ||
                            request.method === 'sources.importDirectory' ||
                            request.method === 'sources.sync' ||
                            request.method === 'sources.revoke'
                          ? await sources(request)
                          : handleWorkspace(store, request),
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    reply = {
      ok: false,
      error:
        code === 'PET_CONTEXT_INVALID_INPUT' ||
        code === 'PET_CONTEXT_UNAVAILABLE' ||
        code === 'ASSOCIATION_INVALID_INPUT' ||
        code === 'ASSOCIATION_NOT_FOUND' ||
        code === 'ASSOCIATION_CONFLICT' ||
        code === 'ASSOCIATION_UNAVAILABLE' ||
        code === 'ASSOCIATION_LIMIT_EXCEEDED' ||
        code === 'ASSOCIATION_CORRUPT_DATA' ||
        code === 'ASSOCIATION_INVALID_CURSOR' ||
        code === 'PLAN_CHANGE_INVALID_INPUT' ||
        code === 'PLAN_CHANGE_NOT_FOUND' ||
        code === 'PLAN_CHANGE_NOT_APPLICABLE' ||
        code === 'TIMELINE_INVALID_CURSOR' ||
        code === 'TIMELINE_CORRUPT_DATA' ||
        code === 'FEISHU_PAGE_LOOP' ||
        code === 'FEISHU_PAGE_LIMIT' ||
        code === 'INVALID_REFERENCE_REVIEW' ||
        code === 'REFERENCE_REVIEW_CONFLICT' ||
        code === 'REFERENCE_RETRACTED' ||
        code === 'REFERENCE_ALREADY_INVALID' ||
        code === 'INGESTION_QUEUE_LIMIT' ||
        code === 'INGESTION_DATABASE_LIMIT' ||
        code === 'INGESTION_DISK_LOW' ||
        code === 'INGESTION_PROBE_UNAVAILABLE'
          ? code
          : code.startsWith('FEISHU_')
            ? 'FEISHU_FAILED'
            : code.startsWith('GITHUB_')
              ? 'GITHUB_FAILED'
              : code === 'EXPORT_LIMIT_EXCEEDED'
                ? 'EXPORT_LIMIT_EXCEEDED'
                : code === 'EXPORT_CORRUPT_DATA'
                  ? 'EXPORT_INVALID_DATA'
                  : code === 'EXPORT_TASK_NOT_IN_PROJECT' ||
                      code === 'EXPORT_UNKNOWN_PROJECT'
                    ? 'NOT_FOUND'
                      : code === 'VERSION_CONFLICT'
                        ? 'VERSION_CONFLICT'
                        : code === 'INVALID_TASK_SPLIT'
                          ? code
                          : code === 'TASK_NOT_IN_PROJECT' || code === 'NOT_FOUND'
                            ? 'NOT_FOUND'
                            : 'INVALID_REQUEST',
    }
  }
  parentPort.postMessage({ id: data.id, reply })
})
process.on('exit', () => {
  processing.dispose()
  analysis.dispose()
  chat.dispose()
  store.close()
})
parentPort.postMessage({ ready: true })
processing.start()

import { handlePluginHost } from './plugins'
import { createSourceHandler } from './sources'
import { handleWorkspace } from './workspace'
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
    reply = {
      ok: true,
      data:
        request.method === 'pluginHost.list' ||
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
        code === 'EXPORT_LIMIT_EXCEEDED'
          ? 'EXPORT_LIMIT_EXCEEDED'
          : code === 'EXPORT_CORRUPT_DATA'
            ? 'EXPORT_INVALID_DATA'
            : code === 'EXPORT_TASK_NOT_IN_PROJECT' ||
                code === 'EXPORT_UNKNOWN_PROJECT'
              ? 'NOT_FOUND'
              : code === 'VERSION_CONFLICT'
                ? 'VERSION_CONFLICT'
                : code === 'TASK_NOT_IN_PROJECT'
                  ? 'NOT_FOUND'
                  : 'INVALID_REQUEST',
    }
  }
  parentPort.postMessage({ id: data.id, reply })
})
process.on('exit', () => store.close())
parentPort.postMessage({ ready: true })

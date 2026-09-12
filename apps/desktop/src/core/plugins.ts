import type { PluginHostRequest } from '@memo/contracts'
import type { openStore } from '@memo/storage'
import { parseSourceManifest } from '@memo/plugin-host'
export function handlePluginHost(
  store: ReturnType<typeof openStore>,
  request: PluginHostRequest,
): unknown {
  switch (request.method) {
    case 'pluginHost.list':
      return store.plugins.list()
    case 'pluginHost.get':
      return store.plugins.get(request.id)
    case 'pluginHost.activate':
      return store.plugins.activate({
        ...request.input,
        manifest: parseSourceManifest(request.input.manifest),
      })
    case 'pluginHost.disable':
      return store.plugins.disable(request.id)
    case 'pluginHost.uninstall':
      return store.plugins.uninstall(request.id)
    case 'pluginHost.receiveBatch':
      return store.plugins.receiveBatch(request.input)
    case 'pluginHost.recordError':
      return store.plugins.recordError(request.id, request.grantVersion)
  }
}

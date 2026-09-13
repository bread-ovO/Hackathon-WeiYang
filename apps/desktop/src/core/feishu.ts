import type { FeishuHostRequest, HostRequest } from '@memo/contracts'
import type { openStore } from '@memo/storage'
/** Internal host-only routes. Renderer cannot submit observations or authorization proofs. */
export function handleFeishuHost(
  store: ReturnType<typeof openStore>,
  request: FeishuHostRequest,
): unknown {
  switch (request.method) {
    case 'feishuHost.getCooldown':
      return store.feishu.getCooldown(request.credentialId)
    case 'feishuHost.recordCooldown':
      return store.feishu.recordCooldown({
        credentialId: request.credentialId,
        notBefore: request.notBefore,
      })
    case 'feishuHost.list':
      return store.feishu.list()
    case 'feishuHost.get':
      return store.feishu.getAuthorized(request.id)
    case 'feishuHost.authorize':
      return store.feishu.authorize(request.input)
    case 'feishuHost.setEnabled':
      return store.feishu.setEnabled(request.id, request.enabled)
    case 'feishuHost.revoke':
      return store.feishu.revoke(request.id)
    case 'feishuHost.beginWindow': {
      const { method: _method, ...input } = request
      return store.feishu.beginWindow(input)
    }
    case 'feishuHost.restartWindow': {
      const { method: _method, ...input } = request
      return store.feishu.restartWindow(input)
    }
    case 'feishuHost.receiveBatch': {
      const { method: _method, ...input } = request
      return store.feishu.receiveBatch(input)
    }
    case 'feishuHost.recordFailure': {
      const { method: _method, ...input } = request
      return store.feishu.recordFailure(input)
    }
    case 'feishuHost.records': {
      const { method: _method, ...input } = request
      return store.feishu.records(input)
    }
  }
}

export function isFeishuHostRequest(
  request: HostRequest,
): request is FeishuHostRequest {
  return request.method.startsWith('feishuHost.')
}

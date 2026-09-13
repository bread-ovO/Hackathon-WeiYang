import type { GithubHostRequest, HostRequest } from '@memo/contracts'
import type { openStore } from '@memo/storage'
/** Internal host-only routes. Renderer cannot submit observations or authorization proofs. */
export function handleGithubHost(
  store: ReturnType<typeof openStore>,
  request: GithubHostRequest,
): unknown {
  switch (request.method) {
    case 'githubHost.getCooldown':
      return store.github.getCooldown(request.credentialId)
    case 'githubHost.recordCooldown':
      return store.github.recordCooldown({
        credentialId: request.credentialId,
        notBefore: request.notBefore,
      })
    case 'githubHost.list':
      return store.github.list()
    case 'githubHost.get':
      return store.github.getAuthorized(request.id)
    case 'githubHost.authorize':
      return store.github.authorize(request.input)
    case 'githubHost.setEnabled':
      return store.github.setEnabled(request.id, request.enabled)
    case 'githubHost.revoke':
      return store.github.revoke(request.id)
    case 'githubHost.receiveBatch': {
      const { method: _method, ...input } = request
      return store.github.receiveBatch(input)
    }
    case 'githubHost.recordFailure': {
      const { method: _method, ...input } = request
      return store.github.recordFailure(input)
    }
    case 'githubHost.records': {
      const { method: _method, ...input } = request
      return store.github.records(input)
    }
  }
}

export function isGithubHostRequest(
  request: HostRequest,
): request is GithubHostRequest {
  return request.method.startsWith('githubHost.')
}

import { createHash } from 'node:crypto'
import {
  createFeishuMessagesFetcher,
  FeishuHistoryAdapter,
  createGithubPullRequestsFetcher,
  createGithubAccountFetcher,
  type SourceHttpTransport,
  type SourceAdapter,
} from '@memo/connectors'
import { parseSourceEvent } from '@memo/contracts'
import { createSourceHttpTransport } from './source-http'
export type ProviderSourceConfig = { id: string; credentialId: string } & (
  | {
      kind: 'github'
      mode?: 'repository' | 'account'
      owner: string
      repo: string
      repositoryId?: number
    }
  | {
      kind: 'feishu'
      chatId: string
      startTime?: string
      endTime?: string
      strictScope?: boolean
    }
)
export interface ProviderReaderDependencies {
  readCredential(
    id: string,
    scope: { domain: string; purpose: 'source' },
  ): Promise<string>
  transport?: SourceHttpTransport
}
/** Main-only binding. Adapters hold a placeholder; the vault is consulted before every actual request. */
export function createProviderSourceReader(
  input: ProviderSourceConfig,
  deps: ProviderReaderDependencies,
): SourceAdapter {
  const config = structuredClone(input)
  if (
    !config ||
    !['github', 'feishu'].includes(config.kind) ||
    typeof config.id !== 'string' ||
    !config.id.trim() ||
    config.id.length > 128 ||
    /[\s\u0000-\u001f\u007f]/.test(config.id) ||
    typeof config.credentialId !== 'string' ||
    !config.credentialId.trim() ||
    config.credentialId.length > 128
  )
    throw new Error('PROVIDER_INVALID_CONFIG')
  const domain = config.kind === 'github' ? 'api.github.com' : 'open.feishu.cn'
  const http = deps.transport ?? createSourceHttpTransport()
  // Bind cached pages to the credential that produced them; retain only hashes.
  const cacheScopes = new Map<string, string>()
  let stagedScope: { url: string; fingerprint: string } | undefined
  let busy = false
  const transport: SourceHttpTransport = async (request) => {
    if (
      request.allowedDomain !== domain ||
      new URL(request.url).hostname !== domain
    )
      throw new Error('PROVIDER_SCOPE_MISMATCH')
    if (request.signal.aborted) throw new Error('PROVIDER_CANCELLED')
    const token = await deps.readCredential(config.credentialId, {
      domain,
      purpose: 'source',
    })
    if (request.signal.aborted) throw new Error('PROVIDER_CANCELLED')
    const fingerprint = createHash('sha256').update(token).digest('hex')
    const sameScope = cacheScopes.get(request.url) === fingerprint
    const headers = { ...request.headers }
    if (!sameScope)
      for (const name of Object.keys(headers))
        if (['if-none-match', 'if-modified-since'].includes(name.toLowerCase()))
          delete headers[name]
    const response = await http({ ...request, headers, bearerToken: token })
    if (request.signal.aborted) throw new Error('PROVIDER_CANCELLED')
    if (response.status === 304 && !sameScope)
      throw new Error('PROVIDER_SCOPE_MISMATCH')
    if (response.status === 200) {
      // The adapter may replace its page cache before final event validation.
      cacheScopes.delete(request.url)
      stagedScope = { url: request.url, fingerprint }
    }
    return response
  }
  let pull: SourceAdapter['pull']
  if (config.kind === 'github')
    pull =
      config.mode === 'account'
        ? createGithubAccountFetcher(
            'host-managed',
            config.repositoryId!,
            transport,
          )
        : createGithubPullRequestsFetcher(
            'host-managed',
            config.owner,
            config.repo,
            transport,
            config.repositoryId,
          )
  else {
    const adapter = new FeishuHistoryAdapter(
      config.id,
      createFeishuMessagesFetcher('host-managed', config.chatId, transport, {
        strictScope: config.strictScope,
        ...(config.startTime ? { startTime: new Date(config.startTime) } : {}),
        ...(config.endTime ? { endTime: new Date(config.endTime) } : {}),
      }),
    )
    pull = (cursor, signal) => adapter.pull(cursor, signal)
  }
  return {
    kind: config.kind === 'github' ? 'github.pr' : 'feishu.im',
    pull: async (cursor, signal) => {
      if (busy) throw new Error('PROVIDER_BUSY')
      busy = true
      stagedScope = undefined
      try {
        const result = await pull(cursor, signal)
        if (signal.aborted) throw new Error('PROVIDER_CANCELLED')
        const events = result.events.map((event) =>
          parseSourceEvent({ ...event, sourceInstanceId: config.id }),
        )
        // Commit only after the adapter accepted the response and updated its page cache.
        if (stagedScope) {
          const { url, fingerprint } = stagedScope as {
            url: string
            fingerprint: string
          }
          cacheScopes.delete(url)
          if (cacheScopes.size >= 32)
            cacheScopes.delete(cacheScopes.keys().next().value!)
          cacheScopes.set(url, fingerprint)
        }
        return { events, nextCursor: result.nextCursor }
      } finally {
        stagedScope = undefined
        busy = false
      }
    },
  }
}

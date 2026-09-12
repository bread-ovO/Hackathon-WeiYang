import {
  createFeishuMessagesFetcher,
  FeishuHistoryAdapter,
  createGithubPullRequestsFetcher,
  type SourceHttpTransport,
  type SourceAdapter,
} from '@memo/connectors'
import { parseSourceEvent } from '@memo/contracts'
import { createSourceHttpTransport } from './source-http'
export type ProviderSourceConfig = { id: string; credentialId: string } & (
  | { kind: 'github'; owner: string; repo: string }
  | { kind: 'feishu'; chatId: string; startTime?: string; endTime?: string }
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
    return http({ ...request, bearerToken: token })
  }
  let pull: SourceAdapter['pull']
  if (config.kind === 'github')
    pull = createGithubPullRequestsFetcher(
      'host-managed',
      config.owner,
      config.repo,
      transport,
    )
  else {
    const adapter = new FeishuHistoryAdapter(
      config.id,
      createFeishuMessagesFetcher('host-managed', config.chatId, transport, {
        ...(config.startTime ? { startTime: new Date(config.startTime) } : {}),
        ...(config.endTime ? { endTime: new Date(config.endTime) } : {}),
      }),
    )
    pull = (cursor, signal) => adapter.pull(cursor, signal)
  }
  return {
    kind: config.kind === 'github' ? 'github.pr' : 'feishu.im',
    pull: async (cursor, signal) => {
      const result = await pull(cursor, signal)
      if (signal.aborted) throw new Error('PROVIDER_CANCELLED')
      return {
        events: result.events.map((event) =>
          parseSourceEvent({ ...event, sourceInstanceId: config.id }),
        ),
        nextCursor: result.nextCursor,
      }
    },
  }
}

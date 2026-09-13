import { randomUUID } from 'node:crypto'
import {
  GithubConnectorError,
  GithubRateLimitError,
  verifyGithubRepository,
  verifyGithubAccount,
  type SourceHttpTransport,
} from '@memo/connectors'
import {
  githubErrorCodes,
  type CoreReply,
  type HostRequest,
  type GithubRequest,
  type GithubConnection,
  type GithubAuthorized,
  type GithubConnectionError,
  type GithubSnapshot,
  type IngestionStatus,
} from '@memo/contracts'
import { createProviderSourceReader } from './provider-reader'
import { createSourceHttpTransport } from './source-http'

export interface GithubRuntimeDependencies {
  request(request: HostRequest): Promise<CoreReply<unknown>>
  readCredential(
    id: string,
    scope: { domain: string; purpose: 'source' },
  ): Promise<string>
  transport?: SourceHttpTransport
  now?: () => number
}
const pressure = {
  queue_limit: 'INGESTION_QUEUE_LIMIT',
  database_limit: 'INGESTION_DATABASE_LIMIT',
  disk_low: 'INGESTION_DISK_LOW',
  probe_unavailable: 'INGESTION_PROBE_UNAVAILABLE',
} as const
const publicErrors = new Set<string>([
  ...githubErrorCodes,
  'GITHUB_BUSY',
  'GITHUB_NOT_DUE',
  'GITHUB_CANCELLED',
  'GITHUB_INVALID',
  'GITHUB_UNAVAILABLE',
  'CORE_UNAVAILABLE',
  'NOT_FOUND',
  'INVALID_REQUEST',
])
function classify(error: unknown): GithubConnectionError {
  if (error instanceof GithubConnectorError) {
    if (
      error.code === 'INVALID_GITHUB_RESPONSE' ||
      error.code === 'INVALID_GITHUB_CURSOR'
    )
      return 'GITHUB_INVALID_RESPONSE'
    if (githubErrorCodes.includes(error.code as GithubConnectionError))
      return error.code as GithubConnectionError
  }
  if (
    error instanceof Error &&
    githubErrorCodes.includes(error.message as GithubConnectionError)
  )
    return error.message as GithubConnectionError
  return 'GITHUB_REQUEST_FAILED'
}
/** Main-only scheduler. Due times and the grant/cursor fence live in SQLite, not this process. */
export function createGithubRuntime(deps: GithubRuntimeDependencies) {
  const now = deps.now ?? Date.now,
    transport = deps.transport ?? createSourceHttpTransport()
  const running = new Map<string, AbortController>(),
    blocked = new Set<string>()
  type ReaderEntry = {
    key: string
    reader: ReturnType<typeof createProviderSourceReader>
    current?: { signal: AbortSignal; failed: () => void }
  }
  const readers = new Map<string, ReaderEntry>()
  const credentialWork = new Set<string>()
  type Cooldown = { notBefore: number; failureCount: number }
  const getCooldown = (credentialId: string) =>
    call<Cooldown>({ method: 'githubHost.getCooldown', credentialId })
  async function recordCooldown(
    credentialId: string,
    error: GithubRateLimitError,
    previous: Cooldown,
  ) {
    return call<Cooldown>({
      method: 'githubHost.recordCooldown',
      credentialId,
      notBefore: Math.min(
        8_640_000_000_000_000,
        now() +
          Math.max(
            error.retryAfterMs,
            1000,
            Math.min(
              3_600_000,
              30_000 * 2 ** Math.min(previous.failureCount, 7),
            ),
          ),
      ),
    })
  }
  const removingCredentials = new Set<string>()
  let stopped = false,
    ticking = false,
    connecting: AbortController | undefined
  let connectingCredential: string | undefined,
    connectDone: Promise<void> = Promise.resolve()
  async function call<T>(request: HostRequest): Promise<T> {
    const result = await deps.request(request)
    if (!result.ok) throw new Error(result.error)
    return structuredClone(result.data) as T
  }
  const list = () => call<GithubConnection[]>({ method: 'githubHost.list' })
  const snapshot = async (): Promise<GithubSnapshot> => ({
    connections: await list(),
  })
  function live(signal: AbortSignal) {
    if (stopped || signal.aborted) throw new Error('GITHUB_CANCELLED')
  }
  function cancel(id?: string) {
    if (id) {
      running.get(id)?.abort()
      readers.delete(id)
    } else {
      connecting?.abort()
      readers.clear()
      for (const controller of running.values()) controller.abort()
    }
  }
  function reader(
    config: {
      id: string
      owner: string
      repo: string
      mode?: 'repository' | 'account'
      repositoryId: number
      credentialId: string
    },
    signal: AbortSignal,
    credentialFailed: () => void,
  ) {
    return createProviderSourceReader(
      { ...config, kind: 'github' },
      {
        transport,
        readCredential: async (id, scope) => {
          live(signal)
          try {
            const token = await deps.readCredential(id, scope)
            live(signal)
            return token
          } catch (error) {
            if (!signal.aborted) credentialFailed()
            throw error
          }
        },
      },
    )
  }
  function cachedReader(binding: GithubAuthorized): ReaderEntry {
    const key = JSON.stringify([
      binding.projectId,
      binding.owner,
      binding.repo,
      binding.repositoryId,
      binding.mode,
      binding.credentialId,
      binding.grantVersion,
    ])
    const old = readers.get(binding.id)
    if (old?.key === key) {
      readers.delete(binding.id)
      readers.set(binding.id, old)
      return old
    }
    const entry: ReaderEntry = { key, reader: undefined! }
    entry.reader = createProviderSourceReader(
      { ...binding, kind: 'github' },
      {
        transport,
        readCredential: async (id, scope) => {
          const current = entry.current
          if (!current) throw new Error('GITHUB_CANCELLED')
          live(current.signal)
          try {
            const token = await deps.readCredential(id, scope)
            live(current.signal)
            return token
          } catch (error) {
            if (!current.signal.aborted) current.failed()
            throw error
          }
        },
      },
    )
    readers.delete(binding.id)
    if (readers.size >= 32) readers.delete(readers.keys().next().value!)
    readers.set(binding.id, entry)
    return entry
  }
  async function sync(id: string) {
    if (stopped) throw new Error('GITHUB_UNAVAILABLE')
    if (running.has(id) || blocked.has(id)) throw new Error('GITHUB_BUSY')
    const controller = new AbortController(),
      signal = controller.signal
    running.set(id, controller)
    let binding: GithubAuthorized | undefined,
      credentialFailed = false
    let claimedCredential: string | undefined,
      cooldown: Cooldown | undefined,
      sharedDeadline: number | undefined
    try {
      binding = await call<GithubAuthorized>({ method: 'githubHost.get', id })
      live(signal)
      if (removingCredentials.has(binding.credentialId))
        throw new Error('GITHUB_CANCELLED')
      if (!binding.enabled || binding.revoked)
        throw new Error('GITHUB_UNAVAILABLE')
      if (binding.nextPollAt > now()) throw new Error('GITHUB_NOT_DUE')
      if (credentialWork.has(binding.credentialId))
        throw new Error('GITHUB_BUSY')
      credentialWork.add(binding.credentialId)
      claimedCredential = binding.credentialId
      cooldown = await getCooldown(binding.credentialId)
      live(signal)
      if (cooldown.notBefore > now()) {
        sharedDeadline = cooldown.notBefore
        throw new Error('GITHUB_RATE_LIMITED')
      }
      const budget = await call<IngestionStatus>({ method: 'ingestion.status' })
      live(signal)
      if (budget.paused)
        throw new Error(
          budget.reason
            ? pressure[budget.reason]
            : 'INGESTION_PROBE_UNAVAILABLE',
        )
      const entry = cachedReader(binding)
      entry.current = {
        signal,
        failed: () => {
          credentialFailed = true
        },
      }
      const batch = await entry.reader
        .pull(binding.cursor, signal)
        .finally(() => {
          entry.current = undefined
        })
      live(signal)
      await call({
        method: 'githubHost.receiveBatch',
        id,
        expectedGrantVersion: binding.grantVersion,
        expectedPollVersion: binding.pollVersion,
        expectedCursor: binding.cursor,
        events: batch.events,
        nextCursor: batch.nextCursor,
        nextPollAt: now() + (batch.nextCursor ? 1000 : 300_000),
      })
      live(signal)
    } catch (error) {
      live(signal)
      if (
        !binding ||
        !binding.enabled ||
        binding.revoked ||
        (error instanceof Error &&
          [
            'GITHUB_NOT_DUE',
            'CORE_UNAVAILABLE',
            'GITHUB_CANCELLED',
            'GITHUB_BUSY',
          ].includes(error.message))
      )
        throw error
      if (error instanceof GithubRateLimitError && cooldown) {
        sharedDeadline = (
          await recordCooldown(binding.credentialId, error, cooldown)
        ).notBefore
        live(signal)
      }
      const code = credentialFailed
        ? 'GITHUB_CREDENTIAL_UNAVAILABLE'
        : classify(error)
      const delay =
        error instanceof GithubRateLimitError
          ? Math.max(
              1000,
              error.retryAfterMs,
              Math.min(
                3_600_000,
                30_000 * 2 ** Math.min(binding.failureCount, 7),
              ),
            )
          : code.startsWith('INGESTION_')
            ? 60_000
            : Math.min(
                3_600_000,
                30_000 * 2 ** Math.min(binding.failureCount, 7),
              )
      await call({
        method: 'githubHost.recordFailure',
        id,
        expectedGrantVersion: binding.grantVersion,
        expectedPollVersion: binding.pollVersion,
        expectedCursor: binding.cursor,
        errorCode: code,
        ...(error instanceof GithubConnectorError && error.scope
          ? { errorScope: error.scope }
          : {}),
        nextPollAt: Math.min(
          8_640_000_000_000_000,
          Math.max(binding.nextPollAt, sharedDeadline ?? now() + delay),
        ),
      })
      throw new Error(code)
    } finally {
      if (claimedCredential) credentialWork.delete(claimedCredential)
      if (running.get(id) === controller) running.delete(id)
    }
  }
  async function handle(input: GithubRequest): Promise<CoreReply<unknown>> {
    try {
      const request = structuredClone(input)
      if (stopped) throw new Error('GITHUB_UNAVAILABLE')
      if (request.method === 'github.list')
        return { ok: true, data: await snapshot() }
      if (request.method === 'github.records')
        return {
          ok: true,
          data: await call({ ...request, method: 'githubHost.records' }),
        }
      if (
        request.method === 'github.connect' ||
        request.method === 'github.connectAccount'
      ) {
        if (connecting || removingCredentials.has(request.credentialId))
          throw new Error('GITHUB_BUSY')
        const controller = new AbortController()
        connecting = controller
        connectingCredential = request.credentialId
        let finishConnect!: () => void
        connectDone = new Promise<void>((resolve) => {
          finishConnect = resolve
        })
        let credentialFailed = false,
          claimed = false
        let cooldown: Cooldown | undefined
        try {
          if (credentialWork.has(request.credentialId))
            throw new Error('GITHUB_BUSY')
          credentialWork.add(request.credentialId)
          claimed = true
          cooldown = await getCooldown(request.credentialId)
          live(controller.signal)
          if (cooldown.notBefore > now()) throw new Error('GITHUB_NOT_DUE')
          const mode =
            request.method === 'github.connectAccount'
              ? ('account' as const)
              : ('repository' as const)
          let owner =
            request.method === 'github.connect'
              ? request.owner.toLowerCase()
              : ''
          const repo =
            request.method === 'github.connect'
              ? request.repo.toLowerCase()
              : ''
          const signal = controller.signal
          // This initial metadata call also resolves the vault at request time.
          const boundTransport: SourceHttpTransport = async (input) => {
            live(signal)
            let token: string
            try {
              token = await deps.readCredential(request.credentialId, {
                domain: 'api.github.com',
                purpose: 'source',
              })
            } catch {
              credentialFailed = true
              throw new Error('GITHUB_CREDENTIAL_UNAVAILABLE')
            }
            live(signal)
            const result = await transport({ ...input, bearerToken: token })
            live(signal)
            return result
          }
          const account =
            mode === 'account'
              ? await verifyGithubAccount(
                  'host-managed',
                  boundTransport,
                  signal,
                )
              : null
          if (account) owner = account.login
          const repositoryId =
            account?.id ??
            (await verifyGithubRepository(
              'host-managed',
              owner,
              repo,
              boundTransport,
              signal,
            ))
          if (mode === 'repository')
            await reader(
              {
                id: randomUUID(),
                owner,
                repo,
                repositoryId,
                mode,
                credentialId: request.credentialId,
              },
              signal,
              () => {
                credentialFailed = true
              },
            ).pull('', signal)
          live(signal)
          await call({
            method: 'githubHost.authorize',
            input: {
              projectId: request.projectId,
              owner,
              repo,
              repositoryId,
              mode,
              credentialId: request.credentialId,
            },
          })
          live(signal)
        } catch (error) {
          live(controller.signal)
          if (error instanceof GithubRateLimitError && cooldown) {
            await recordCooldown(request.credentialId, error, cooldown)
            live(controller.signal)
          }
          if (credentialFailed) throw new Error('GITHUB_CREDENTIAL_UNAVAILABLE')
          throw error
        } finally {
          if (connecting === controller) {
            connecting = undefined
            connectingCredential = undefined
          }
          if (claimed) credentialWork.delete(request.credentialId)
          finishConnect()
        }
      } else if (request.method === 'github.sync') await sync(request.id)
      else {
        if (blocked.has(request.id)) throw new Error('GITHUB_BUSY')
        if (request.method === 'github.setEnabled' && request.enabled) {
          const binding = await call<GithubAuthorized>({
            method: 'githubHost.get',
            id: request.id,
          })
          if (removingCredentials.has(binding.credentialId))
            throw new Error('GITHUB_BUSY')
        }
        blocked.add(request.id)
        cancel(request.id)
        try {
          if (request.method === 'github.setEnabled')
            await call({ ...request, method: 'githubHost.setEnabled' })
          else await call({ ...request, method: 'githubHost.revoke' })
        } finally {
          blocked.delete(request.id)
        }
      }
      return { ok: true, data: await snapshot() }
    } catch (error) {
      const code =
        error instanceof GithubConnectorError
          ? classify(error)
          : error instanceof Error && publicErrors.has(error.message)
            ? error.message
            : 'GITHUB_UNAVAILABLE'
      return {
        ok: false,
        error: code as Extract<CoreReply<unknown>, { ok: false }>['error'],
      }
    }
  }
  async function tick() {
    if (stopped || ticking) return
    ticking = true
    try {
      const connections = await list()
      if (stopped) return
      const due = connections
        .filter(
          (x) =>
            !['paused', 'revoked'].includes(x.status) &&
            x.nextPollAt <= now() &&
            !running.has(x.id) &&
            !blocked.has(x.id),
        )
        .sort((a, b) => a.nextPollAt - b.nextPollAt || a.id.localeCompare(b.id))
        .slice(0, 4)
      await Promise.allSettled(due.map((x) => sync(x.id)))
    } finally {
      ticking = false
    }
  }
  async function removeCredential(
    id: string,
    remove: () => Promise<CoreReply<unknown>>,
  ): Promise<CoreReply<unknown>> {
    if (removingCredentials.has(id)) return { ok: false, error: 'GITHUB_BUSY' }
    removingCredentials.add(id)
    try {
      if (connectingCredential === id) {
        connecting?.abort()
        await connectDone
      }
      const connections = await list()
      for (const connection of connections.filter(
        (x) => x.credentialId === id && x.status !== 'revoked',
      )) {
        blocked.add(connection.id)
        cancel(connection.id)
        try {
          await call({
            method: 'githubHost.setEnabled',
            id: connection.id,
            enabled: false,
          })
        } finally {
          blocked.delete(connection.id)
        }
      }
      return await remove()
    } catch {
      return { ok: false, error: 'GITHUB_UNAVAILABLE' }
    } finally {
      removingCredentials.delete(id)
    }
  }
  return {
    handle,
    tick,
    cancel,
    removeCredential,
    stop() {
      stopped = true
      cancel()
    },
  }
}

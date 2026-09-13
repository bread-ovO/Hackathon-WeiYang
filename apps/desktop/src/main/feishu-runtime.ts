import { randomUUID } from 'node:crypto'
import {
  FeishuConnectorError,
  FeishuRateLimitError,
  type SourceHttpTransport,
} from '@memo/connectors'
import {
  feishuErrorCodes,
  type CoreReply,
  type HostRequest,
  type FeishuRequest,
  type FeishuConnection,
  type FeishuAuthorized,
  type FeishuConnectionError,
  type FeishuSnapshot,
  type IngestionStatus,
} from '@memo/contracts'
import { createProviderSourceReader } from './provider-reader'
import { createSourceHttpTransport } from './source-http'

export interface FeishuRuntimeDependencies {
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
  ...feishuErrorCodes,
  'FEISHU_BUSY',
  'FEISHU_NOT_DUE',
  'FEISHU_CANCELLED',
  'FEISHU_INVALID',
  'FEISHU_UNAVAILABLE',
  'CORE_UNAVAILABLE',
  'NOT_FOUND',
  'INVALID_REQUEST',
])
function classify(error: unknown): FeishuConnectionError {
  if (error instanceof FeishuConnectorError) {
    if (error.code === 'INVALID_PAGE_CURSOR') return 'FEISHU_PAGE_LOOP'
    if (error.code === 'INVALID_FEISHU_RESPONSE')
      return 'FEISHU_INVALID_RESPONSE'
    if (feishuErrorCodes.includes(error.code as FeishuConnectionError))
      return error.code as FeishuConnectionError
  }
  if (
    error instanceof Error &&
    feishuErrorCodes.includes(error.message as FeishuConnectionError)
  )
    return error.message as FeishuConnectionError
  return 'FEISHU_HTTP_FAILED'
}
/** Main-only scheduler. Due times and the grant/cursor fence live in SQLite, not this process. */
export function createFeishuRuntime(deps: FeishuRuntimeDependencies) {
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
    call<Cooldown>({ method: 'feishuHost.getCooldown', credentialId })
  async function recordCooldown(
    credentialId: string,
    error: FeishuRateLimitError,
    previous: Cooldown,
  ) {
    return call<Cooldown>({
      method: 'feishuHost.recordCooldown',
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
  const list = () => call<FeishuConnection[]>({ method: 'feishuHost.list' })
  const snapshot = async (): Promise<FeishuSnapshot> => ({
    connections: await list(),
  })
  function live(signal: AbortSignal) {
    if (stopped || signal.aborted) throw new Error('FEISHU_CANCELLED')
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
      chatId: string
      startTime: string
      endTime: string
      credentialId: string
    },
    signal: AbortSignal,
    credentialFailed: () => void,
  ) {
    return createProviderSourceReader(
      { ...config, kind: 'feishu', strictScope: true },
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
  function cachedReader(binding: FeishuAuthorized): ReaderEntry {
    const key = JSON.stringify([
      binding.projectId,
      binding.chatId,
      binding.windowStart,
      binding.windowEnd,
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
      {
        id: binding.id,
        credentialId: binding.credentialId,
        chatId: binding.chatId,
        kind: 'feishu',
        strictScope: true,
        startTime: new Date(binding.windowStart).toISOString(),
        endTime: new Date(binding.windowEnd).toISOString(),
      },
      {
        transport,
        readCredential: async (id, scope) => {
          const current = entry.current
          if (!current) throw new Error('FEISHU_CANCELLED')
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
    if (stopped) throw new Error('FEISHU_UNAVAILABLE')
    if (running.has(id) || blocked.has(id)) throw new Error('FEISHU_BUSY')
    const controller = new AbortController(),
      signal = controller.signal
    running.set(id, controller)
    let binding: FeishuAuthorized | undefined,
      credentialFailed = false
    let claimedCredential: string | undefined,
      cooldown: Cooldown | undefined,
      sharedDeadline: number | undefined
    try {
      binding = await call<FeishuAuthorized>({ method: 'feishuHost.get', id })
      live(signal)
      if (removingCredentials.has(binding.credentialId))
        throw new Error('FEISHU_CANCELLED')
      if (!binding.enabled || binding.revoked)
        throw new Error('FEISHU_UNAVAILABLE')
      if (
        binding.errorCode === 'FEISHU_PAGE_LIMIT' ||
        binding.errorCode === 'FEISHU_PAGE_LOOP'
      )
        throw new Error(binding.errorCode)
      if (binding.nextPollAt > now()) throw new Error('FEISHU_NOT_DUE')
      if (credentialWork.has(binding.credentialId))
        throw new Error('FEISHU_BUSY')
      credentialWork.add(binding.credentialId)
      claimedCredential = binding.credentialId
      cooldown = await getCooldown(binding.credentialId)
      live(signal)
      if (cooldown.notBefore > now()) {
        sharedDeadline = cooldown.notBefore
        throw new Error('FEISHU_RATE_LIMITED')
      }
      const budget = await call<IngestionStatus>({ method: 'ingestion.status' })
      live(signal)
      if (budget.paused)
        throw new Error(
          budget.reason
            ? pressure[budget.reason]
            : 'INGESTION_PROBE_UNAVAILABLE',
        )
      if (!binding.windowActive) {
        const until = Math.floor(now() / 1000) * 1000
        if (
          binding.completedThrough === null ||
          until <= binding.completedThrough
        )
          throw new Error('FEISHU_NOT_DUE')
        binding = await call<FeishuAuthorized>({
          method: 'feishuHost.beginWindow',
          id,
          expectedGrantVersion: binding.grantVersion,
          expectedPollVersion: binding.pollVersion,
          until,
        })
        live(signal)
      }
      const entry = cachedReader(binding)
      entry.current = {
        signal,
        failed: () => {
          credentialFailed = true
        },
      }
      const batch = await entry.reader
        .pull(binding.pageToken, signal)
        .finally(() => {
          entry.current = undefined
        })
      live(signal)
      await call({
        method: 'feishuHost.receiveBatch',
        id,
        expectedGrantVersion: binding.grantVersion,
        expectedPollVersion: binding.pollVersion,
        expectedPageToken: binding.pageToken,
        expectedWindowStart: binding.windowStart,
        expectedWindowEnd: binding.windowEnd,
        events: batch.events,
        nextPageToken: batch.nextCursor,
        nextPollAt:
          now() +
          (batch.nextCursor ||
          binding.windowEnd < Math.floor(now() / 1000) * 1000 - 120_000
            ? 1000
            : 60_000),
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
            'FEISHU_NOT_DUE',
            'CORE_UNAVAILABLE',
            'FEISHU_CANCELLED',
            'FEISHU_BUSY',
            ...(binding.errorCode === 'FEISHU_PAGE_LIMIT' ||
            binding.errorCode === 'FEISHU_PAGE_LOOP'
              ? [binding.errorCode]
              : []),
          ].includes(error.message))
      )
        throw error
      if (error instanceof FeishuRateLimitError && cooldown) {
        sharedDeadline = (
          await recordCooldown(binding.credentialId, error, cooldown)
        ).notBefore
        live(signal)
      }
      const code = credentialFailed
        ? 'FEISHU_CREDENTIAL_UNAVAILABLE'
        : classify(error)
      const delay =
        error instanceof FeishuRateLimitError
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
        method: 'feishuHost.recordFailure',
        id,
        expectedGrantVersion: binding.grantVersion,
        expectedPollVersion: binding.pollVersion,
        errorCode: code,
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
  async function handle(input: FeishuRequest): Promise<CoreReply<unknown>> {
    try {
      const request = structuredClone(input)
      if (stopped) throw new Error('FEISHU_UNAVAILABLE')
      if (request.method === 'feishu.list')
        return { ok: true, data: await snapshot() }
      if (request.method === 'feishu.records')
        return {
          ok: true,
          data: await call({ ...request, method: 'feishuHost.records' }),
        }
      if (request.method === 'feishu.connect') {
        if (connecting || removingCredentials.has(request.credentialId))
          throw new Error('FEISHU_BUSY')
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
            throw new Error('FEISHU_BUSY')
          credentialWork.add(request.credentialId)
          claimed = true
          cooldown = await getCooldown(request.credentialId)
          live(controller.signal)
          if (cooldown.notBefore > now()) throw new Error('FEISHU_NOT_DUE')
          const signal = controller.signal,
            endTime = Math.floor(now() / 1000) * 1000
          if (
            !Number.isSafeInteger(request.startTime) ||
            request.startTime % 1000 !== 0 ||
            request.startTime < 0 ||
            request.startTime >= endTime
          )
            throw new Error('FEISHU_INVALID')
          await reader(
            {
              id: randomUUID(),
              chatId: request.chatId,
              credentialId: request.credentialId,
              startTime: new Date(request.startTime).toISOString(),
              endTime: new Date(
                Math.min(request.startTime + 86_400_000, endTime),
              ).toISOString(),
            },
            signal,
            () => {
              credentialFailed = true
            },
          ).pull('', signal)
          live(signal)
          await call({
            method: 'feishuHost.authorize',
            input: {
              projectId: request.projectId,
              chatId: request.chatId,
              startTime: request.startTime,
              endTime,
              credentialId: request.credentialId,
            },
          })
          live(signal)
        } catch (error) {
          live(controller.signal)
          if (error instanceof FeishuRateLimitError && cooldown) {
            await recordCooldown(request.credentialId, error, cooldown)
            live(controller.signal)
          }
          if (credentialFailed) throw new Error('FEISHU_CREDENTIAL_UNAVAILABLE')
          throw error
        } finally {
          if (connecting === controller) {
            connecting = undefined
            connectingCredential = undefined
          }
          if (claimed) credentialWork.delete(request.credentialId)
          finishConnect()
        }
      } else if (request.method === 'feishu.sync') await sync(request.id)
      else {
        if (blocked.has(request.id)) throw new Error('FEISHU_BUSY')
        if (request.method === 'feishu.setEnabled' && request.enabled) {
          const binding = await call<FeishuAuthorized>({
            method: 'feishuHost.get',
            id: request.id,
          })
          if (removingCredentials.has(binding.credentialId))
            throw new Error('FEISHU_BUSY')
        }
        blocked.add(request.id)
        cancel(request.id)
        try {
          if (request.method === 'feishu.setEnabled')
            await call({ ...request, method: 'feishuHost.setEnabled' })
          else if (request.method === 'feishu.restartWindow') {
            const binding = await call<FeishuAuthorized>({
              method: 'feishuHost.get',
              id: request.id,
            })
            if (removingCredentials.has(binding.credentialId))
              throw new Error('FEISHU_BUSY')
            const cooldown = await getCooldown(binding.credentialId)
            if (cooldown.notBefore > now() || binding.nextPollAt > now())
              throw new Error('FEISHU_NOT_DUE')
            await call({
              method: 'feishuHost.restartWindow',
              id: request.id,
              expectedGrantVersion: binding.grantVersion,
              expectedPollVersion: binding.pollVersion,
            })
          } else await call({ ...request, method: 'feishuHost.revoke' })
        } finally {
          blocked.delete(request.id)
        }
      }
      return { ok: true, data: await snapshot() }
    } catch (error) {
      const code =
        error instanceof FeishuConnectorError
          ? classify(error)
          : error instanceof Error && publicErrors.has(error.message)
            ? error.message
            : 'FEISHU_UNAVAILABLE'
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
            x.errorCode !== 'FEISHU_PAGE_LIMIT' &&
            x.errorCode !== 'FEISHU_PAGE_LOOP' &&
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
    if (removingCredentials.has(id)) return { ok: false, error: 'FEISHU_BUSY' }
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
            method: 'feishuHost.setEnabled',
            id: connection.id,
            enabled: false,
          })
        } finally {
          blocked.delete(connection.id)
        }
      }
      return await remove()
    } catch {
      return { ok: false, error: 'FEISHU_UNAVAILABLE' }
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

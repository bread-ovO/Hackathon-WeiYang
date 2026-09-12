import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type {
  CoreReply,
  CoreRequest,
  HostRequest,
  PluginSnapshot,
  PluginInspection,
  PluginTrial,
} from '@memo/contracts'
import {
  parseSourceManifest,
  createHttpJsonReader,
  readLocalJsonl,
  requestHttpsJson,
  readPluginManifestFile,
  type SourceManifest,
  type HttpTransport,
} from '@memo/plugin-host'

type Grant =
  | { kind: 'http-json'; domain: string; credentialId?: string }
  | { kind: 'local-jsonl'; path: string }
type Binding = {
  id: string
  sourceInstanceId: string
  projectId: string
  displayName: string
  version: string
  digest: string
  grantVersion: number
  status: 'active' | 'disabled' | 'error'
  manifest: SourceManifest
  grant: Grant
  cursor: string
}
type Inspection = {
  view: PluginInspection
  manifest: SourceManifest
  created: number
}
type Trial = {
  view: PluginTrial
  inspection: Inspection
  projectId: string
  grant: Grant
  created: number
}
export interface PluginRuntimeDependencies {
  request(request: HostRequest): Promise<CoreReply<unknown>>
  choose(kind: 'manifest' | 'directory'): Promise<string | null>
  readCredential(
    id: string,
    scope: { domain: string; purpose: 'source' },
  ): Promise<string>
  transport?: HttpTransport
  now?: () => number
}
/** Main-process capability owner. Neither trials nor network responses can directly write tasks. */
export function createPluginRuntime(deps: PluginRuntimeDependencies) {
  const now = deps.now ?? Date.now
  let inspection: Inspection | undefined,
    trial: Trial | undefined,
    choosing = false
  const running = new Map<string, AbortController>(),
    attempts = new Map<string, number[]>(),
    lastRun = new Map<string, number>()
  async function call<T>(request: HostRequest): Promise<T> {
    const reply = await deps.request(request)
    if (!reply.ok) throw new Error(reply.error)
    return reply.data as T
  }
  const list = () =>
    call<PluginSnapshot['plugins']>({ method: 'pluginHost.list' })
  const snapshot = async (): Promise<PluginSnapshot> =>
    structuredClone({
      plugins: await list(),
      ...(inspection ? { inspection: inspection.view } : {}),
      ...(trial ? { trial: trial.view } : {}),
    })
  function fresh(created: number) {
    if (now() - created > 10 * 60_000 || now() < created)
      throw new Error('PLUGIN_CONFLICT')
  }
  async function read(
    manifest: SourceManifest,
    grant: Grant,
    sourceInstanceId: string,
    cursor: string,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw new Error('PLUGIN_UNAVAILABLE')
    if (manifest.kind === 'local-jsonl' && grant.kind === 'local-jsonl') {
      const batch = await readLocalJsonl({
        manifest,
        path: grant.path,
        sourceInstanceId,
        cursor: cursor ? JSON.parse(cursor) : undefined,
      })
      if (signal.aborted) throw new Error('PLUGIN_UNAVAILABLE')
      return batch
    }
    if (
      manifest.kind !== 'http-json' ||
      grant.kind !== 'http-json' ||
      grant.domain !== manifest.permissions.domains[0]
    )
      throw new Error('PLUGIN_INVALID')
    const slot = manifest.transport.credentialId
    const credential =
      slot && grant.credentialId
        ? {
            id: slot,
            token: await deps.readCredential(grant.credentialId, {
              domain: grant.domain,
              purpose: 'source',
            }),
          }
        : undefined
    if (Boolean(slot) !== Boolean(credential)) throw new Error('PLUGIN_INVALID')
    if (signal.aborted) throw new Error('PLUGIN_UNAVAILABLE')
    const transport: HttpTransport = async (input) => {
      if (signal.aborted) throw new Error('PLUGIN_UNAVAILABLE')
      // Shared across re-created readers, trials and upgrades, so new instances cannot reset the limit.
      const key = grant.domain,
        time = now(),
        recent = (attempts.get(key) ?? []).filter((x) => time - x < 60_000)
      if (recent.length >= manifest.transport.requestsPerMinute)
        throw new Error('PLUGIN_UNAVAILABLE')
      recent.push(time)
      attempts.set(key, recent)
      return (deps.transport ?? requestHttpsJson)(input)
    }
    const reader = createHttpJsonReader({
      manifest,
      authorization: {
        sourceInstanceId,
        domain: grant.domain,
        ...(credential ? { credential } : {}),
      },
      transport,
      now,
    })
    const checkpoint = cursor ? JSON.parse(cursor) : undefined
    // Completed HTTP snapshots begin a new bounded scan on the next sampling interval.
    return reader.read({
      cursor: checkpoint?.done ? undefined : checkpoint,
      signal,
    })
  }
  async function sync(id: string) {
    if (running.has(id)) throw new Error('PLUGIN_UNAVAILABLE')
    const controller = new AbortController()
    running.set(id, controller)
    let binding: Binding | undefined
    try {
      binding = await call<Binding>({ method: 'pluginHost.get', id })
      if (binding.status !== 'active') throw new Error('PLUGIN_CONFLICT')
      const manifest = parseSourceManifest(binding.manifest)
      const previous = lastRun.get(id)
      if (
        previous !== undefined &&
        now() - previous < manifest.sampling.intervalSeconds * 1000
      )
        throw new Error('PLUGIN_UNAVAILABLE')
      lastRun.set(id, now())
      const batch = await read(
        manifest,
        binding.grant,
        binding.sourceInstanceId,
        binding.cursor,
        controller.signal,
      )
      if (controller.signal.aborted) throw new Error('PLUGIN_CONFLICT')
      await call({
        method: 'pluginHost.receiveBatch',
        input: {
          id,
          grantVersion: binding.grantVersion,
          expectedCursor: binding.cursor,
          cursor: JSON.stringify(batch.cursor),
          events: batch.events,
        },
      })
    } catch (error) {
      if (
        binding &&
        !controller.signal.aborted &&
        (error as Error).message !== 'PLUGIN_UNAVAILABLE'
      )
        await call({
          method: 'pluginHost.recordError',
          id,
          grantVersion: binding.grantVersion,
        }).catch(() => {})
      throw error
    } finally {
      if (running.get(id) === controller) running.delete(id)
    }
  }
  function cancel(id?: string) {
    running.get('$trial')?.abort()
    if (id) running.get(id)?.abort()
    else for (const controller of running.values()) controller.abort()
    // A credential removal or lifecycle action invalidates pending confirmation capabilities.
    trial = undefined
  }
  async function handle(
    request: Extract<CoreRequest, { method: `plugins.${string}` }>,
  ): Promise<CoreReply<PluginSnapshot>> {
    request = structuredClone(request)
    try {
      if (request.method === 'plugins.inspect') {
        if (choosing) throw new Error('PLUGIN_UNAVAILABLE')
        choosing = true
        inspection = undefined
        trial = undefined
        try {
          const file = await deps.choose('manifest')
          if (!file)
            return {
              ok: true,
              data: { ...(await snapshot()), cancelled: true },
            }
          const { manifest, digest } = await readPluginManifestFile(file)
          const existing = (await list()).find((x) => x.id === manifest.id)
          const prior = existing
            ? await call<Binding>({ method: 'pluginHost.get', id: manifest.id })
            : undefined
          const priorManifest = prior
            ? parseSourceManifest(prior.manifest)
            : undefined
          const scope = (m: SourceManifest) =>
            m.kind === 'http-json'
              ? `HTTPS ${m.permissions.domains[0]} · ${m.permissions.credentials[0]?.purpose ?? '无凭据'}`
              : `文件 ${m.transport.file} · ${m.permissions.directories[0]?.purpose ?? ''}`
          const view: PluginInspection = {
            inspectionId: randomUUID(),
            id: manifest.id,
            displayName: manifest.displayName,
            version: manifest.version,
            digest,
            kind: manifest.kind,
            credentialRequired: manifest.permissions.credentials.length > 0,
            permissionChanged: Boolean(
              priorManifest && scope(priorManifest) !== scope(manifest),
            ),
            ...(priorManifest ? { previousScope: scope(priorManifest) } : {}),
            ...(manifest.permissions.credentials[0]
              ? {
                  credentialPurpose:
                    manifest.permissions.credentials[0].purpose,
                }
              : {}),
            ...(manifest.kind === 'http-json'
              ? { domain: manifest.permissions.domains[0] }
              : { file: manifest.transport.file }),
          }
          inspection = { view, manifest, created: now() }
        } finally {
          choosing = false
        }
      } else if (request.method === 'plugins.trial') {
        if (
          choosing ||
          !inspection ||
          request.inspectionId !== inspection.view.inspectionId
        )
          throw new Error('PLUGIN_CONFLICT')
        const selected = inspection
        fresh(selected.created)
        trial = undefined
        choosing = true
        const controller = new AbortController()
        running.set('$trial', controller)
        try {
          const manifest = selected.manifest
          let grant: Grant
          if (manifest.kind === 'local-jsonl') {
            if (request.credentialId) throw new Error('PLUGIN_INVALID')
            const directory = await deps.choose('directory')
            if (!directory)
              return {
                ok: true,
                data: { ...(await snapshot()), cancelled: true },
              }
            const root = await realpath(directory),
              path = resolve(join(root, manifest.transport.file))
            if (!path.startsWith(root + sep) || (await realpath(path)) !== path)
              throw new Error('PLUGIN_INVALID')
            grant = { kind: 'local-jsonl', path }
          } else {
            if (
              Boolean(request.credentialId) !==
              Boolean(manifest.transport.credentialId)
            )
              throw new Error('PLUGIN_INVALID')
            grant = {
              kind: 'http-json',
              domain: manifest.permissions.domains[0]!,
              ...(request.credentialId
                ? { credentialId: request.credentialId }
                : {}),
            }
          }
          const batch = await read(
            manifest,
            grant,
            `trial:${randomUUID()}`,
            '',
            controller.signal,
          )
          if (controller.signal.aborted || inspection !== selected)
            throw new Error('PLUGIN_CONFLICT')
          fresh(selected.created)
          trial = {
            view: {
              trialId: randomUUID(),
              eventCount: batch.events.length,
              done: batch.done,
            },
            inspection: selected,
            projectId: request.projectId,
            grant,
            created: now(),
          }
        } finally {
          choosing = false
          running.delete('$trial')
        }
      } else if (request.method === 'plugins.activate') {
        if (
          !trial ||
          trial.inspection !== inspection ||
          request.trialId !== trial.view.trialId
        )
          throw new Error('PLUGIN_CONFLICT')
        const selected = trial
        fresh(selected.created)
        fresh(selected.inspection.created)
        trial = undefined
        const { manifest, view } = selected.inspection
        cancel(manifest.id)
        await call({
          method: 'pluginHost.activate',
          input: {
            id: manifest.id,
            displayName: manifest.displayName,
            version: manifest.version,
            digest: view.digest,
            manifest,
            grant: selected.grant,
            projectId: selected.projectId,
          },
        })
        inspection = undefined
        lastRun.delete(manifest.id)
      } else if (
        request.method === 'plugins.disable' ||
        request.method === 'plugins.uninstall'
      ) {
        cancel(request.id)
        await call({
          method:
            request.method === 'plugins.disable'
              ? 'pluginHost.disable'
              : 'pluginHost.uninstall',
          id: request.id,
        })
        if (inspection?.view.id === request.id) inspection = undefined
      } else if (request.method === 'plugins.sync') await sync(request.id)
      return { ok: true, data: await snapshot() }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      return {
        ok: false,
        error:
          code === 'PLUGIN_CONFLICT'
            ? 'PLUGIN_CONFLICT'
            : code === 'CORE_UNAVAILABLE'
              ? 'CORE_UNAVAILABLE'
              : code === 'PLUGIN_UNAVAILABLE'
                ? 'PLUGIN_UNAVAILABLE'
                : request.method === 'plugins.trial'
                  ? 'PLUGIN_TRIAL_FAILED'
                  : 'PLUGIN_INVALID',
      }
    }
  }
  async function tick() {
    const plugins = await list()
    for (const plugin of plugins) {
      if (plugin.status !== 'active' || running.has(plugin.id)) continue
      try {
        await sync(plugin.id)
      } catch {
        /* Fixed safe status is persisted by sync; no source/credential logging. */
      }
    }
  }
  return { handle, tick, cancel }
}

import type { openStore } from '@memo/storage'
import type {
  DirectoryImportSummary,
  HostRequest,
  SessionSourceKind,
  SourcesSnapshot,
} from '@memo/contracts'
import {
  readLocalJsonl,
  LocalJsonlError,
  SESSION_MAPPERS,
  SESSION_NORMALIZER_IDS,
} from '@memo/plugin-host'
import { lstat, readdir, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
type SourceRequest = Extract<HostRequest, { method: `sources.${string}` }>
const pressureCodes = new Set([
  'INGESTION_QUEUE_LIMIT',
  'INGESTION_DATABASE_LIMIT',
  'INGESTION_DISK_LOW',
  'INGESTION_PROBE_UNAVAILABLE',
])
/** Display label prefixes double as the persisted kind marker for session
 * sources, so sync after a restart still picks the right record mapper without
 * a schema migration. Path components are only a fallback for older grants. */
const SESSION_DISPLAY_PREFIX: Record<SessionSourceKind, string> = {
  'claude-code': 'Claude Code 会话',
  codex: 'Codex 会话',
}
function sessionKindOf(grant: {
  path: string
  displayName: string
}): SessionSourceKind | null {
  for (const kind of ['claude-code', 'codex'] as const)
    if (
      typeof grant.displayName === 'string' &&
      grant.displayName.startsWith(SESSION_DISPLAY_PREFIX[kind])
    )
      return kind
  const parts = grant.path.split(nodePath.sep)
  if (parts.includes('.claude')) return 'claude-code'
  if (parts.includes('.codex')) return 'codex'
  return null
}
const MAX_DIRECTORY_FILES = 200
export function createSourceHandler(store: ReturnType<typeof openStore>) {
  const active = new Set<string>()
  async function sync(id: string) {
    if (active.has(id)) throw new Error('SOURCE_BUSY')
    active.add(id)
    let grant: ReturnType<typeof store.sources.getAuthorized> | undefined
    try {
      grant = store.sources.getAuthorized(id)
      store.ingestion.assertCanReceive()
      const kind = sessionKindOf(grant)
      const batch = await readLocalJsonl({
        path: grant.path,
        sourceInstanceId: id,
        ...(grant.cursor ? { cursor: JSON.parse(grant.cursor) } : {}),
        ...(kind
          ? {
              normalizeRecord: SESSION_MAPPERS[kind],
              normalizerId: SESSION_NORMALIZER_IDS[kind],
            }
          : {}),
      })
      const currentGrant = store.sources.getAuthorized(id)
      if (currentGrant.grantVersion !== grant.grantVersion)
        throw new Error('SOURCE_REVOKED')
      store.sources.receiveBatch(
        id,
        grant.grantVersion,
        batch.events,
        JSON.stringify(batch.cursor),
        grant.cursor,
      )
    } catch (error) {
      if (
        grant &&
        !(error instanceof Error && pressureCodes.has(error.message))
      )
        store.sources.recordError(
          id,
          grant.grantVersion,
          error instanceof LocalJsonlError
            ? error.code
            : error instanceof Error &&
                error.message === 'SOURCE_REVISION_CONFLICT'
              ? 'SOURCE_REVISION_CONFLICT'
              : 'IMPORT_FAILED',
        )
      throw error
    } finally {
      active.delete(id)
    }
  }
  /** Recursive *.jsonl collection under an already-validated directory.
   * Symlinks are never followed; oversized files stay for the sync loop to
   * reject so they are counted as skipped. Scanning lives here in core; the
   * bounded reader itself never scans directories. */
  async function collectSessionFiles(directory: string) {
    const files: string[] = []
    let truncated = false
    async function walk(current: string): Promise<void> {
      if (truncated) return
      const entries = await readdir(current, { withFileTypes: true })
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (truncated) return
        if (entry.isSymbolicLink()) continue
        const full = nodePath.join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
          if (files.length >= MAX_DIRECTORY_FILES) {
            truncated = true
            return
          }
          files.push(full)
        }
      }
    }
    await walk(directory)
    return { files, truncated }
  }
  return async (request: SourceRequest): Promise<SourcesSnapshot> => {
    switch (request.method) {
      case 'sources.importFile': {
        store.ingestion.assertCanReceive()
        const before = await lstat(request.path)
        if (before.isSymbolicLink() || !before.isFile())
          throw new Error('UNSAFE_SOURCE_PATH')
        const path = await realpath(request.path)
        const after = await lstat(request.path)
        const resolved = await lstat(path)
        if (
          after.isSymbolicLink() ||
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          resolved.ino !== before.ino ||
          resolved.dev !== before.dev
        )
          throw new Error('UNSAFE_SOURCE_PATH')
        const grant = store.sources.authorize({
          path,
          projectId: request.projectId,
        })
        await sync(grant.id)
        break
      }
      case 'sources.importDirectory': {
        store.ingestion.assertCanReceive()
        const before = await lstat(request.path)
        if (before.isSymbolicLink() || !before.isDirectory())
          throw new Error('UNSAFE_SOURCE_PATH')
        const directory = await realpath(request.path)
        const after = await lstat(request.path)
        const resolved = await lstat(directory)
        if (
          after.isSymbolicLink() ||
          before.ino !== after.ino ||
          before.dev !== after.dev ||
          resolved.ino !== before.ino ||
          resolved.dev !== before.dev
        )
          throw new Error('UNSAFE_SOURCE_PATH')
        const { files, truncated } = await collectSessionFiles(directory)
        const summary: DirectoryImportSummary = {
          files: files.length,
          imported: 0,
          skipped: 0,
          truncated,
        }
        for (const path of files) {
          const stat = await lstat(path)
          if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
            summary.skipped++
            continue
          }
          const grant = store.sources.authorize({
            path,
            projectId: request.projectId,
            displayName: `${SESSION_DISPLAY_PREFIX[request.kind]} · ${nodePath.basename(path)}`,
          })
          try {
            await sync(grant.id)
            summary.imported++
          } catch (error) {
            // Backpressure aborts the whole import; per-file failures are
            // already recorded on the source and simply skipped here.
            if (error instanceof Error && pressureCodes.has(error.message))
              throw error
            summary.skipped++
          }
        }
        return { sources: store.sources.list(), directoryImport: summary }
      }
      case 'sources.sync':
        await sync(request.id)
        break
      case 'sources.revoke':
        store.sources.revoke(request.id)
        break
    }
    return { sources: store.sources.list() }
  }
}

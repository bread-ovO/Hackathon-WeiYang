import type { openStore } from '@memo/storage'
import type { HostRequest, SourcesSnapshot } from '@memo/contracts'
import { readLocalJsonl, LocalJsonlError } from '@memo/plugin-host'
import { realpath, lstat } from 'node:fs/promises'
type SourceRequest = Extract<HostRequest, { method: `sources.${string}` }>
export function createSourceHandler(store: ReturnType<typeof openStore>) {
  const active = new Set<string>()
  async function sync(id: string) {
    if (active.has(id)) throw new Error('SOURCE_BUSY')
    active.add(id)
    let grant: ReturnType<typeof store.sources.getAuthorized> | undefined
    try {
      grant = store.sources.getAuthorized(id)
      const batch = await readLocalJsonl({
        path: grant.path,
        sourceInstanceId: id,
        ...(grant.cursor ? { cursor: JSON.parse(grant.cursor) } : {}),
      })
      store.sources.receiveBatch(
        id,
        grant.grantVersion,
        batch.events,
        JSON.stringify(batch.cursor),
        grant.cursor,
      )
    } catch (error) {
      if (grant)
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
  return async (request: SourceRequest): Promise<SourcesSnapshot> => {
    switch (request.method) {
      case 'sources.importFile': {
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

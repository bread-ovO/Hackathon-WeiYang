import { ModelStore, ModelStoreError } from './model-store'
import { findModelEntries, ModelDiscoveryError } from './import-session'
import {
  validRequest,
  validReply,
  slimWorkerData,
  type PetWorkerReply,
} from './worker-protocol'
const parentPort = (
  process as unknown as {
    parentPort?: {
      on(event: 'message', listener: (event: { data: unknown }) => void): void
      postMessage(data: unknown): void
    }
  }
).parentPort
const storeRoot = process.argv[2]
if (!storeRoot || !parentPort) throw new Error('PET_WORKER_STARTUP_INVALID')
const store = new ModelStore(storeRoot)
let queue = Promise.resolve(),
  queued = 0
parentPort.on('message', ({ data }) => {
  if (!validRequest(data)) {
    if (
      data &&
      typeof data === 'object' &&
      'id' in data &&
      typeof data.id === 'string' &&
      /^[a-zA-Z0-9-]{1,64}$/.test(data.id)
    )
      parentPort.postMessage({
        id: data.id,
        reply: { ok: false, error: 'INVALID_REQUEST' },
      })
    return
  }
  const request = structuredClone(data)
  if (queued >= 8) {
    parentPort.postMessage({
      id: request.id,
      reply: { ok: false, error: 'PET_UNAVAILABLE' },
    })
    return
  }
  queued++
  queue = queue
    .then(async () => {
      let reply: PetWorkerReply
      try {
        const p = request.params
        let result: unknown
        switch (request.method) {
          case 'list':
            result = await store.list()
            break
          case 'discover':
            result = await findModelEntries(p!.directory as string)
            break
          case 'import':
            result = await store.importModel(
              p!.directory as string,
              p!.entry as string,
            )
            break
          case 'select':
            result = await store.select(p!.modelId as string | null)
            break
          case 'remove':
            result = await store.remove(p!.modelId as string)
            break
        }
        reply = { ok: true, data: slimWorkerData(result, request.method) }
        if (!validReply(reply, request.method))
          reply = { ok: false, error: 'PET_WORKER_ERROR' }
      } catch (error) {
        reply = {
          ok: false,
          error:
            error instanceof ModelStoreError ||
            error instanceof ModelDiscoveryError
              ? error.code
              : 'PET_WORKER_ERROR',
        }
      }
      parentPort.postMessage({ id: request.id, reply })
    })
    .catch(() => {})
    .finally(() => {
      queued--
    })
})
parentPort.postMessage({ ready: true })

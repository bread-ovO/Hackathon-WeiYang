// PET02/PET04 pet worker: the single owning process for the model store.
// Heavy validation and bounded copying stay off the UI thread. The protocol
// mirrors the core client: {id, method, params} in, {id, reply} out.
import { ModelStore, ModelStoreError } from './model-store'

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
type PetWorkerRequest = {
  id: string
  method: 'list' | 'import' | 'select'
  params?: Record<string, unknown>
}
const fail = (error: unknown) =>
  error instanceof ModelStoreError
    ? { ok: false as const, error: error.code }
    : { ok: false as const, error: 'PET_WORKER_ERROR' }
parentPort.on('message', async ({ data }) => {
  const message = data as PetWorkerRequest
  if (!message || typeof message !== 'object' || typeof message.id !== 'string')
    return
  const reply = await (async () => {
    try {
      if (message.method === 'list') return { ok: true as const, data: await store.list() }
      if (message.method === 'import') {
        const directory = message.params?.directory
        const entry = message.params?.entry
        if (typeof directory !== 'string' || typeof entry !== 'string')
          return { ok: false as const, error: 'INVALID_REQUEST' }
        return { ok: true as const, data: await store.importModel(directory, entry) }
      }
      if (message.method === 'select') {
        const modelId = message.params?.modelId
        if (modelId !== null && typeof modelId !== 'string')
          return { ok: false as const, error: 'INVALID_REQUEST' }
        return { ok: true as const, data: await store.select(modelId ?? null) }
      }
      return { ok: false as const, error: 'INVALID_REQUEST' }
    } catch (error) {
      return fail(error)
    }
  })()
  parentPort.postMessage({ id: message.id, reply })
})
parentPort.postMessage({ ready: true })

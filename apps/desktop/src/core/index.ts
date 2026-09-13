import { openStore } from '@memo/storage'
import { parseCoreRequest, type CoreReply } from '@memo/contracts'
import { JobRunner, type JobHandler } from '@memo/application'
import { randomUUID } from 'node:crypto'
const parentPort = (
  process as unknown as {
    parentPort: {
      on(event: 'message', listener: (event: { data: unknown }) => void): void
      postMessage(data: unknown): void
    }
  }
).parentPort
const path = process.argv[2]
if (!path || !parentPort) throw new Error('CORE_STARTUP_INVALID')
const store = openStore(path)
// A provider must register a real handler. Unconfigured work stays pending and visible.
const handlers = new Map<string, JobHandler>()
store.setAvailablePipelines([...handlers.keys()])
const runner = new JobRunner(store, handlers, { owner: randomUUID() })
runner.start()
parentPort.on('message', ({ data }) => {
  if (
    !data ||
    typeof data !== 'object' ||
    !('id' in data) ||
    !('request' in data) ||
    typeof data.id !== 'string'
  )
    return
  let reply: CoreReply
  try {
    const request = parseCoreRequest(data.request)
    if (request.method === 'resumeSource') store.resumeSource(request.sourceId)
    if (request.method === 'updateCapacity') store.setLimits(request.limits)
    reply = { ok: true, data: store.health() }
  } catch (error) {
    reply = {
      ok: false,
      error:
        error instanceof Error && error.message === 'INVALID_REQUEST'
          ? 'INVALID_REQUEST'
          : 'INTERNAL_ERROR',
    }
  }
  parentPort.postMessage({ id: data.id, reply })
})
process.on('exit', () => {
  void runner.stop()
  store.close()
})
parentPort.postMessage({ ready: true })

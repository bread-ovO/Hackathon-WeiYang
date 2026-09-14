import { randomUUID } from 'node:crypto'
import type { TaskModelRequest } from '@memo/model'
export function createTaskModelBridge(port: {
  on(event: 'message', listener: (event: { data: any }) => void): void
  postMessage(value: unknown): void
}) {
  const pending = new Map<
    string,
    {
      resolve: (value: { content: string; model: string }) => void
      reject: (error: Error) => void
      cleanup: () => void
    }
  >()
  port.on('message', ({ data }) => {
    if (data?.kind !== 'model.result' || typeof data.id !== 'string') return
    const p = pending.get(data.id)
    if (!p) return
    p.cleanup()
    pending.delete(data.id)
    if (
      typeof data.content === 'string' &&
      data.content.length <= 65536 &&
      typeof data.model === 'string' &&
      data.model.length <= 256
    )
      p.resolve({ content: data.content, model: data.model })
    else
      p.reject(
        new Error(
          typeof data.error === 'string' ? data.error : 'MODEL_UNAVAILABLE',
        ),
      )
  })
  return (
    input: TaskModelRequest,
  ): Promise<{ content: string; model: string }> =>
    new Promise((resolve, reject) => {
      if (input.signal.aborted) return reject(new Error('MODEL_CANCELLED'))
      const id = randomUUID()
      const cancel = () => {
        const p = pending.get(id)
        if (!p) return
        p.cleanup()
        pending.delete(id)
        port.postMessage({ kind: 'model.cancel', id })
        reject(new Error('MODEL_CANCELLED'))
      }
      input.signal.addEventListener('abort', cancel, { once: true })
      pending.set(id, {
        resolve,
        reject,
        cleanup: () => input.signal.removeEventListener('abort', cancel),
      })
      port.postMessage({ kind: 'model.analyze', id, messages: input.messages })
    })
}

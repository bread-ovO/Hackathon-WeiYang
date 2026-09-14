import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { taskAnalysisSchema, taskChatOutputSchema } from '@memo/contracts'
import type { TaskModelRequest } from '@memo/model'
import type { CoreReply, HostRequest } from '@memo/contracts'
export class CoreClient {
  modelHandler?: (
    input: TaskModelRequest,
  ) => Promise<{ content: string; model: string }>
  private modelCalls = new Map<string, AbortController>()
  private child: UtilityProcess | null = null
  private ready = false
  private stopped = false
  private restarts = 0
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<
    string,
    {
      resolve: (value: CoreReply<unknown>) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(
    private entry: string,
    private databasePath: string,
  ) {}
  start(): void {
    if (this.child || this.stopped) return
    const child = utilityProcess.fork(this.entry, [this.databasePath], {
      serviceName: 'Memo Core',
      stdio: 'ignore',
    })
    this.child = child
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return
      if (
        'kind' in message &&
        'id' in message &&
        typeof message.id === 'string'
      ) {
        const id = message.id
        if (message.kind === 'model.cancel') {
          this.modelCalls.get(id)?.abort()
          return
        }
        if (message.kind === 'model.analyze') {
          if (
            !this.modelHandler ||
            this.modelCalls.size ||
            !('messages' in message) ||
            !Array.isArray(message.messages) ||
            message.messages.length > 6 ||
            !message.messages.every(
              (m) =>
                m &&
                ['system', 'user'].includes(m.role) &&
                typeof m.content === 'string' &&
                m.content.length <= 200000,
            )
          ) {
            child.postMessage({
              kind: 'model.result',
              id,
              error: 'MODEL_UNAVAILABLE',
            })
            return
          }
          const controller = new AbortController()
          this.modelCalls.set(id, controller)
          void this.modelHandler({
            messages: message.messages,
            schema: 'purpose' in message && message.purpose === 'task-chat' ? taskChatOutputSchema : taskAnalysisSchema,
            signal: controller.signal,
          })
            .then((result) => {
              if (this.child === child)
                child.postMessage({ kind: 'model.result', id, ...result })
            })
            .catch((error) => {
              if (this.child === child)
                child.postMessage({
                  kind: 'model.result',
                  id,
                  error:
                    error instanceof Error &&
                    /^MODEL_[A-Z_]+$|^INVALID_TASK_ANALYSIS$/.test(
                      error.message,
                    )
                      ? error.message
                      : 'MODEL_UNAVAILABLE',
                })
            })
            .finally(() => this.modelCalls.delete(id))
          return
        }
      }
      if ('ready' in message && message.ready === true) {
        this.ready = true
        return
      }
      if (
        'id' in message &&
        typeof message.id === 'string' &&
        'reply' in message
      ) {
        const pending = this.pending.get(message.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          pending.resolve(message.reply as CoreReply<unknown>)
        }
      }
    })
    child.on('exit', () => {
      this.child = null
      this.ready = false
      this.flush()
      // Bounded retries; repeated startup failures remain visible instead of looping forever.
      if (!this.stopped && this.restarts < 3) {
        this.restarts++
        this.restartTimer = setTimeout(() => this.start(), 500 * this.restarts)
      }
    })
  }
  request(request: HostRequest): Promise<CoreReply<unknown>> {
    if (!this.ready || !this.child || this.pending.size >= 32)
      return Promise.resolve({ ok: false, error: 'CORE_UNAVAILABLE' })
    const id = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'CORE_UNAVAILABLE' })
      }, 3000)
      this.pending.set(id, { resolve, timer })
      this.child?.postMessage({ id, request })
    })
  }
  private flush() {
    for (const c of this.modelCalls.values()) c.abort()
    this.modelCalls.clear()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: 'CORE_UNAVAILABLE' })
    }
    this.pending.clear()
  }
  stop() {
    this.stopped = true
    clearTimeout(this.restartTimer)
    this.flush()
    this.child?.kill()
  }
}

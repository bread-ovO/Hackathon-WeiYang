import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

export interface PetSnapshot {
  currentModelId: string | null
  models: { id: string; entry: string; importedAt: string; totalBytes: number; resources: unknown[] }[]
}
export type PetWorkerReply =
  | { ok: true; data: unknown }
  | { ok: false; error: string }

/** UI-process client for the pet worker. No auto-restart here (PET14 owns
 * resilience); a dead worker surfaces as PET_UNAVAILABLE until app restart. */
export class PetWorkerClient {
  private child: UtilityProcess | null = null
  private ready = false
  private stopped = false
  private pending = new Map<
    string,
    { resolve: (reply: PetWorkerReply) => void; timer: ReturnType<typeof setTimeout> }
  >()
  constructor(
    private entry: string,
    private storeRoot: string,
  ) {}
  start(): void {
    if (this.child || this.stopped) return
    mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 })
    const child = utilityProcess.fork(this.entry, [this.storeRoot], {
      serviceName: 'Pet Model Worker',
      stdio: 'ignore',
    })
    this.child = child
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return
      if ('ready' in message && message.ready === true) {
        this.ready = true
        return
      }
      if ('id' in message && typeof message.id === 'string' && 'reply' in message) {
        const pending = this.pending.get(message.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(message.id)
          pending.resolve(message.reply as PetWorkerReply)
        }
      }
    })
    child.on('exit', () => {
      this.child = null
      this.ready = false
      this.flush()
    })
  }
  request(method: 'list' | 'import' | 'select', params?: Record<string, unknown>): Promise<PetWorkerReply> {
    if (!this.ready || !this.child || this.pending.size >= 8)
      return Promise.resolve({ ok: false, error: 'PET_UNAVAILABLE' })
    const id = randomUUID()
    return new Promise((resolve) => {
      // Imports copy bounded bytes to disk; state calls are instant.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'PET_UNAVAILABLE' })
      }, 30_000)
      this.pending.set(id, { resolve, timer })
      this.child?.postMessage({ id, method, params })
    })
  }
  private flush() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: 'PET_UNAVAILABLE' })
    }
    this.pending.clear()
  }
  stop(): void {
    this.stopped = true
    this.flush()
    this.child?.kill()
  }
}

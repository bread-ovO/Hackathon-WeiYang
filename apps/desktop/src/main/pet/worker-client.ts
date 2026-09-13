import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import {
  boundedMessage,
  validReply,
  validRequest,
  type PetWorkerMethod,
  type PetWorkerReply,
} from './worker-protocol'
export type { PetSnapshot, PetWorkerReply } from './worker-protocol'
/** Timeout means outcome unknown: terminate the owner and require app restart/recovery.
 * Never let an apparently failed import continue writing in a hidden worker. */
export class PetWorkerClient {
  private child: UtilityProcess | null = null
  private ready = false
  private stopped = false
  private startupTimer: ReturnType<typeof setTimeout> | undefined
  private pending = new Map<
    string,
    {
      resolve: (reply: PetWorkerReply) => void
      timer: ReturnType<typeof setTimeout>
      method: PetWorkerMethod
      message: unknown
    }
  >()
  constructor(
    private entry: string,
    private storeRoot: string,
    private fork: typeof utilityProcess.fork = (...args) =>
      utilityProcess.fork(...args),
  ) {}
  start(): void {
    if (this.child || this.stopped) return
    try {
      mkdirSync(this.storeRoot, { recursive: true, mode: 0o700 })
      const child = this.fork(this.entry, [this.storeRoot], {
        serviceName: 'Pet Model Worker',
        stdio: 'ignore',
      })
      this.child = child
      this.startupTimer = setTimeout(() => this.stop(), 5000)
      child.on('message', (message: unknown) => {
        if (this.child !== child || this.stopped) return
        if (
          !message ||
          typeof message !== 'object' ||
          !boundedMessage(message)
        ) {
          this.stop()
          return
        }
        const m = message as Record<string, unknown>
        if (Object.keys(m).length === 1 && m.ready === true) {
          if (this.ready) {
            this.stop()
            return
          }
          clearTimeout(this.startupTimer)
          this.ready = true
          for (const p of this.pending.values()) {
            try {
              child.postMessage(p.message)
            } catch {
              this.stop()
              break
            }
          }
          return
        }
        if (
          Object.keys(m).length !== 2 ||
          typeof m.id !== 'string' ||
          !Object.hasOwn(m, 'reply')
        ) {
          this.stop()
          return
        }
        const p = this.pending.get(m.id)
        if (!p || !this.ready || !validReply(m.reply, p.method)) {
          this.stop()
          return
        }
        const reply = structuredClone(m.reply)
        clearTimeout(p.timer)
        this.pending.delete(m.id)
        p.resolve(reply)
      })
      child.on('exit', () => {
        if (this.child === child) this.stop()
      })
    } catch {
      this.stop()
    }
  }
  request(
    method: PetWorkerMethod,
    params?: Record<string, unknown>,
  ): Promise<PetWorkerReply> {
    const message = {
      id: randomUUID(),
      method,
      ...(params === undefined ? {} : { params }),
    }
    if (!validRequest(message))
      return Promise.resolve({ ok: false, error: 'INVALID_REQUEST' })
    if (this.stopped || !this.child || this.pending.size >= 8)
      return Promise.resolve({ ok: false, error: 'PET_UNAVAILABLE' })
    const snapshot = structuredClone(message)
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.stop(), 30000)
      this.pending.set(message.id, {
        resolve,
        timer,
        method,
        message: snapshot,
      })
      if (this.ready)
        try {
          this.child!.postMessage(snapshot)
        } catch {
          this.stop()
        }
    })
  }
  stop(): void {
    this.stopped = true
    this.ready = false
    clearTimeout(this.startupTimer)
    const child = this.child
    this.child = null
    try {
      child?.kill()
    } catch {
      /* Best effort; never restart another store owner. */
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: 'PET_UNAVAILABLE' })
    }
    this.pending.clear()
  }
}

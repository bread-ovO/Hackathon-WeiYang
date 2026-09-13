import type Database from 'better-sqlite3'
import { lstatSync, readdirSync, statfsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Health } from '@memo/contracts/foundation'
export interface Limits {
  eventBytes: number
  pageBytes: number
  pageEvents: number
  cursorBytes: number
  queueHigh: number
  queueLow: number
  diskBytes: number
  reserveBytes: number
}
export const DEFAULT_LIMITS: Limits = {
  eventBytes: 256 * 1024,
  pageBytes: 2 * 1024 * 1024,
  pageEvents: 100,
  cursorBytes: 4096,
  queueHigh: 10000,
  queueLow: 8000,
  diskBytes: 512 * 1024 * 1024,
  reserveBytes: 16 * 1024 * 1024,
}
export interface StoreOptions {
  now?: () => number
  fault?: (point: string) => void
  probe?: () => { usedBytes: number; availableBytes: number }
  limits?: Partial<Limits>
  allowAutoComplete?: boolean
  sqlitePageLimit?: number
}
export type PauseCode = Health['pauses'][number]['code']
export interface Context {
  db: Database.Database
  path: string
  now: () => number
  fault: (point: string) => void
  limits: Limits
  allowAutoComplete: boolean
  probe: () => { usedBytes: number; availableBytes: number }
  guard: (estimate?: number) => void
  resourceState: () => { usedBytes: number; availableBytes: number | null }
  pauses: Map<string, PauseCode>
  depth: () => number
}
function managedSize(path: string, depth = 0): number {
  if (depth > 8) throw new Error('DISK_UNAVAILABLE')
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error('DISK_UNAVAILABLE')
  if (!stat.isDirectory()) return stat.size
  const entries = readdirSync(path)
  if (entries.length > 10000) throw new Error('DISK_UNAVAILABLE')
  return entries.reduce(
    (sum, name) => sum + managedSize(join(path, name), depth + 1),
    0,
  )
}
export function makeContext(
  db: Database.Database,
  path: string,
  options: StoreOptions,
): Context {
  const stored = db
    .prepare("SELECT value FROM store_meta WHERE key='limits'")
    .get() as { value: string } | undefined
  const limits = {
    ...DEFAULT_LIMITS,
    ...(stored ? JSON.parse(stored.value) : {}),
    ...options.limits,
  } as Limits
  validateLimits(limits)
  const pauses = new Map<string, PauseCode>()
  if (db.prepare("SELECT 1 FROM store_meta WHERE key='queue_paused'").get())
    pauses.set('queue', 'QUEUE_LIMIT')
  const probe =
    options.probe ??
    (() => {
      const fs = statfsSync(dirname(path))
      return {
        usedBytes: [
          path,
          path + '-wal',
          path + '-shm',
          path + '.backups',
          path + '.assets',
        ].reduce((n, p) => n + managedSize(p), 0),
        availableBytes: fs.bavail * fs.bsize,
      }
    })
  const ctx: Context = {
    db,
    path,
    limits,
    pauses,
    now: options.now ?? Date.now,
    fault: options.fault ?? (() => {}),
    allowAutoComplete: options.allowAutoComplete ?? false,
    probe,
    resourceState: () => {
      try {
        const state = probe()
        if (
          !Number.isFinite(state.usedBytes) ||
          state.usedBytes < 0 ||
          !Number.isFinite(state.availableBytes) ||
          state.availableBytes < 0
        )
          throw new Error('DISK_UNAVAILABLE')
        pauses.delete('disk-probe')
        if (
          state.usedBytes >= limits.diskBytes ||
          state.availableBytes < limits.reserveBytes
        )
          pauses.set('disk', 'DISK_LIMIT')
        else pauses.delete('disk')
        return state
      } catch {
        pauses.set('disk-probe', 'DISK_UNAVAILABLE')
        return { usedBytes: 0, availableBytes: null }
      }
    },
    guard: (estimate = 0) => {
      const s = ctx.resourceState()
      if (s.availableBytes === null) throw new Error('DISK_UNAVAILABLE')
      const budget = Math.max(65536, estimate * 8)
      if (
        s.usedBytes + budget > limits.diskBytes ||
        s.availableBytes - budget < limits.reserveBytes
      ) {
        pauses.set('disk', 'DISK_LIMIT')
        throw new Error('DISK_LIMIT')
      }
    },
    depth: () =>
      (
        db
          .prepare(
            "SELECT count(*) AS n FROM jobs WHERE state IN ('pending','running','retry_wait','paused')",
          )
          .get() as { n: number }
      ).n,
  }
  return ctx
}
export function validateLimits(limits: Limits): void {
  if (
    Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 0) ||
    limits.queueLow >= limits.queueHigh ||
    limits.eventBytes < 1 ||
    limits.pageBytes < 1 ||
    limits.pageEvents < 1 ||
    limits.pageEvents > 1000 ||
    limits.diskBytes < 1 ||
    limits.cursorBytes < 1
  )
    throw new Error('INVALID_LIMITS')
}
export function iso(ctx: Context): string {
  return new Date(ctx.now()).toISOString()
}

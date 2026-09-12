import type Database from 'better-sqlite3'
import { lstatSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type { SourceEvent } from '@memo/contracts'
export interface IngestionLimits {
  maxQueuedJobs: number
  maxDatabaseBytes: number
  minFreeDiskBytes: number
}
export interface IngestionDiskSnapshot {
  databaseBytes: number
  freeDiskBytes: number
}
export type IngestionReason =
  | 'queue_limit'
  | 'database_limit'
  | 'disk_low'
  | 'probe_unavailable'
export interface IngestionStatus {
  paused: boolean
  reason: IngestionReason | null
  pendingCount: number
  databaseBytes: number | null
  freeDiskBytes: number | null
  limits: IngestionLimits
}
export const INGESTION_DEFAULT_LIMITS: Readonly<IngestionLimits> =
  Object.freeze({
    maxQueuedJobs: 10000,
    maxDatabaseBytes: 512 * 1024 ** 2,
    minFreeDiskBytes: 256 * 1024 ** 2,
  })
const codes: Record<IngestionReason, string> = {
  queue_limit: 'INGESTION_QUEUE_LIMIT',
  database_limit: 'INGESTION_DATABASE_LIMIT',
  disk_low: 'INGESTION_DISK_LOW',
  probe_unavailable: 'INGESTION_PROBE_UNAVAILABLE',
}
export class IngestionBudgetError extends Error {
  constructor(readonly reason: IngestionReason) {
    super(codes[reason])
  }
}
const integer = (n: unknown, min: number, max: number): n is number =>
  Number.isSafeInteger(n) && (n as number) >= min && (n as number) <= max
function limits(value: unknown): IngestionLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('INVALID_INGESTION_CONFIG')
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).length !== 3 ||
    !integer(v.maxQueuedJobs, 1, 100000) ||
    !integer(v.maxDatabaseBytes, 1024 ** 2, 8 * 1024 ** 3) ||
    !integer(v.minFreeDiskBytes, 1024 ** 2, 16 * 1024 ** 3)
  )
    throw Error('INVALID_INGESTION_CONFIG')
  return {
    maxQueuedJobs: v.maxQueuedJobs,
    maxDatabaseBytes: v.maxDatabaseBytes,
    minFreeDiskBytes: v.minFreeDiskBytes,
  }
}
/** Real filesystem occupancy; no renderer path or configured probe is accepted. */
export function probeIngestionDisk(
  databasePath: string,
): IngestionDiskSnapshot {
  if (!isAbsolute(databasePath))
    throw new IngestionBudgetError('probe_unavailable')
  const size = (path: string, optional = false) => {
    try {
      const s = lstatSync(path, { bigint: true })
      if (!s.isFile() || s.isSymbolicLink())
        throw new IngestionBudgetError('probe_unavailable')
      return s.size
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
        return 0n
      throw error
    }
  }
  try {
    const occupied = size(databasePath) + size(`${databasePath}-wal`, true)
    const fs = statfsSync(dirname(databasePath), { bigint: true }),
      free = fs.bavail * fs.bsize
    if (
      fs.bsize <= 0n ||
      occupied < 0n ||
      free < 0n ||
      occupied > BigInt(Number.MAX_SAFE_INTEGER) ||
      free > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('INVALID_SIZE')
    return { databaseBytes: Number(occupied), freeDiskBytes: Number(free) }
  } catch {
    throw new IngestionBudgetError('probe_unavailable')
  }
}
export function migrateIngestionBudget(db: Database.Database) {
  db.transaction(() =>
    db.exec(
      `CREATE TABLE ingestion_limits(id INTEGER PRIMARY KEY CHECK(id=1),max_queued_jobs INTEGER NOT NULL CHECK(max_queued_jobs BETWEEN 1 AND 100000),max_database_bytes INTEGER NOT NULL CHECK(max_database_bytes BETWEEN 1048576 AND 8589934592),min_free_disk_bytes INTEGER NOT NULL CHECK(min_free_disk_bytes BETWEEN 1048576 AND 17179869184));INSERT INTO ingestion_limits VALUES(1,10000,536870912,268435456);PRAGMA user_version=9;`,
    ),
  )()
}
export function createIngestionBudget(
  db: Database.Database,
  options: { probe?: () => IngestionDiskSnapshot } = {},
) {
  const probe = options.probe ?? (() => probeIngestionDisk(db.name))
  let reservedBytes = 0,
    depth = 0
  const readLimits = () =>
    limits(
      db
        .prepare(
          'SELECT max_queued_jobs AS maxQueuedJobs,max_database_bytes AS maxDatabaseBytes,min_free_disk_bytes AS minFreeDiskBytes FROM ingestion_limits WHERE id=1',
        )
        .get(),
    )
  function status(additionalBytes = 0): IngestionStatus {
    const config = readLimits()
    const pendingCount = (
      db
        .prepare(
          "SELECT count(*) AS n FROM jobs WHERE state IN('pending','running')",
        )
        .get() as { n: number }
    ).n
    let disk: IngestionDiskSnapshot
    try {
      const result = probe()
      disk = {
        databaseBytes: result?.databaseBytes,
        freeDiskBytes: result?.freeDiskBytes,
      }
      if (
        !integer(disk.databaseBytes, 0, Number.MAX_SAFE_INTEGER) ||
        !integer(disk.freeDiskBytes, 0, Number.MAX_SAFE_INTEGER)
      )
        throw Error('INVALID_PROBE')
    } catch {
      return {
        paused: true,
        reason: 'probe_unavailable',
        pendingCount,
        databaseBytes: null,
        freeDiskBytes: null,
        limits: config,
      }
    }
    const expected = reservedBytes + additionalBytes
    const reason: IngestionReason | null =
      pendingCount >= config.maxQueuedJobs
        ? 'queue_limit'
        : disk.databaseBytes >= config.maxDatabaseBytes ||
            disk.databaseBytes + expected > config.maxDatabaseBytes
          ? 'database_limit'
          : disk.freeDiskBytes - expected < config.minFreeDiskBytes
            ? 'disk_low'
            : null
    return {
      paused: reason !== null,
      reason,
      pendingCount,
      ...disk,
      limits: config,
    }
  }
  return {
    getStatus(): IngestionStatus {
      return status()
    },
    configure(patch: Partial<IngestionLimits>): IngestionStatus {
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.keys(patch).length === 0 ||
        Object.keys(patch).some(
          (k) => !Object.hasOwn(INGESTION_DEFAULT_LIMITS, k),
        )
      )
        throw Error('INVALID_INGESTION_CONFIG')
      const next = limits({ ...readLimits(), ...patch })
      db.prepare(
        'UPDATE ingestion_limits SET max_queued_jobs=?,max_database_bytes=?,min_free_disk_bytes=? WHERE id=1',
      ).run(next.maxQueuedJobs, next.maxDatabaseBytes, next.minFreeDiskBytes)
      return status()
    },
    /** Wrap the outer source/plugin batch AND standalone receive. Nested guards
     * reserve space for uncommitted rows; rollback restores the reservation too. */
    withBatch<T>(operation: () => T): T {
      const before = reservedBytes
      depth++
      try {
        return operation()
      } catch (error) {
        reservedBytes = before
        if (
          error &&
          typeof error === 'object' &&
          (error as { code?: unknown }).code === 'SQLITE_FULL'
        )
          throw new IngestionBudgetError('disk_low')
        throw error
      } finally {
        depth--
        if (depth === 0) reservedBytes = 0
      }
    },
    assertCanReceive(event?: SourceEvent): void {
      // Soft growth estimate includes the event, context/project indexes and WAL.
      // SQLITE_FULL remains a transactional error; this is not a hard disk quota.
      const reservation = event
        ? Buffer.byteLength(JSON.stringify(event), 'utf8') * 2 + 16384
        : 0
      const current = status(reservation)
      if (current.reason) throw new IngestionBudgetError(current.reason)
      if (event && depth > 0) reservedBytes += reservation
    },
  }
}

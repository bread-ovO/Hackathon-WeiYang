export const taskStatuses = [
  'todo',
  'in_progress',
  'waiting',
  'completed',
  'cancelled',
] as const
export type TaskStatus = (typeof taskStatuses)[number]
export type EvidenceStatus = 'unknown' | 'partial' | 'sufficient' | 'conflict'
export interface Task {
  id: string
  title: string
  status: TaskStatus
  evidenceStatus: EvidenceStatus
  version: number
  archivedAt: string | null
}
// Archiving only changes visibility. It must never infer delivery or completion.
export function archiveTask(task: Task, at: string): Task {
  if (!Number.isFinite(Date.parse(at))) throw new Error('INVALID_DATE')
  return { ...task, archivedAt: at, version: task.version + 1 }
}
export function assertExpectedVersion(current: number, expected: number): void {
  if (current !== expected) throw new Error('VERSION_CONFLICT')
}

export interface StoredTask extends Omit<Task, 'status'> {
  status: TaskStatus | null
  intake: 'candidate' | 'accepted' | 'ignored' | null
  projectId: string | null
  criteriaVersion: number
  manualVersion: number
  legacy: boolean
  dueAt: string | null
}
export interface RevisionFact {
  id: number
  revision: string
  eventType: string
  basis: string
  sequence: number | null
  updatedAt: string | null
  predecessor: string | null
}
export interface ObjectHead {
  eventId: number | null
  state: 'current' | 'tombstone' | 'uncertain'
}
// Recompute from facts, never arrival order. An opaque revision is not a sequence number.
export function resolveObjectHead(facts: readonly RevisionFact[]): ObjectHead {
  if (!facts.length) return { eventId: null, state: 'uncertain' }
  const tombstone = (e: RevisionFact) =>
    e.eventType === 'deleted' || e.eventType === 'retracted'
  let candidates = [...facts]
  const basis = facts[0]!.basis
  let reliable = facts.every((e) => e.basis === basis)
  if (reliable && (basis === 'sequence' || basis === 'source_time')) {
    const order = (e: RevisionFact) =>
      basis === 'sequence'
        ? (e.sequence ?? -Infinity)
        : Date.parse(e.updatedAt ?? '')
    const max = Math.max(...facts.map(order))
    candidates = facts.filter((e) => order(e) === max)
  } else if (reliable && basis === 'predecessor') {
    const superseded = new Set(
      facts.map((e) => e.predecessor).filter((v): v is string => v !== null),
    )
    candidates = facts.filter((e) => !superseded.has(e.revision))
    const known = new Set(facts.map((e) => e.revision))
    reliable = facts.every((e) => {
      const visited = new Set<string>()
      let current: RevisionFact | undefined = e
      while (current) {
        if (visited.has(current.revision)) return false
        visited.add(current.revision)
        if (current.predecessor === null) return true
        if (!known.has(current.predecessor)) return false
        current = facts.find((f) => f.revision === current!.predecessor)
      }
      return false
    })
  } else {
    reliable =
      reliable &&
      facts.length === 1 &&
      basis === 'opaque' &&
      facts[0]!.eventType === 'created'
  }
  const dead = (reliable ? candidates : facts).filter(tombstone)
  if (dead.length)
    return {
      eventId: dead.length === 1 ? dead[0]!.id : null,
      state: 'tombstone',
    }
  if (candidates.length !== 1) return { eventId: null, state: 'uncertain' }
  return {
    eventId: candidates[0]!.id,
    state: reliable ? 'current' : 'uncertain',
  }
}

export function normalizeTimestamp(value: string | null): string | null {
  if (value === null) return null
  if (!Number.isFinite(Date.parse(value))) throw new Error('INVALID_DATE')
  return new Date(value).toISOString()
}
export function identityKey(
  provider: string,
  tenant: string | null,
  account: string,
  namespace: string,
  externalId: string,
): string {
  const parts = [provider, tenant, account, namespace, externalId]
  if (
    parts.some(
      (p, i) =>
        i !== 1 && (typeof p !== 'string' || !p.length || p.length > 256),
    )
  )
    throw new Error('INVALID_IDENTITY')
  return JSON.stringify(parts)
}

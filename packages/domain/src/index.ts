export const taskStatuses = ['todo','in_progress','waiting','completed','cancelled'] as const
export type TaskStatus = typeof taskStatuses[number]
export type EvidenceStatus = 'unknown' | 'partial' | 'sufficient' | 'conflict'
export interface Task {
  id:string; title:string; status:TaskStatus; evidenceStatus:EvidenceStatus; version:number; archivedAt:string|null
}
// Archiving only changes visibility. It must never infer delivery or completion.
export function archiveTask(task: Task, at: string): Task {
  if (!Number.isFinite(Date.parse(at))) throw new Error('INVALID_DATE')
  return { ...task, archivedAt:at, version:task.version+1 }
}
export function assertExpectedVersion(current:number, expected:number): void {
  if (current !== expected) throw new Error('VERSION_CONFLICT')
}

export { normalizeIdentity, parseContextTimestamp, normalizeEventTime, comparePlanUpdates } from './context'
export type { ContextIdentity, NormalizedIdentity, ContextTimestamp, EventTimeInput, NormalizedEventTime, PlanUpdate, PlanUpdateDecision } from './context'

/** Parse an ISO date or date-time from trusted model output. */
export function parseDeadline(value: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return null
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

export interface ProgressCandidate { kind: 'progress' | 'change'; text: string }
export function extractProgressCandidates(text: string): ProgressCandidate[] { return text.split(/\n+/).map(x=>x.trim()).filter(Boolean).flatMap(line => line.includes('完成') ? [{kind:'progress',text:line}] : /更新|变更|改为/.test(line) ? [{kind:'change',text:line}] : []) }

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
export function extractProgressCandidates(text: string): ProgressCandidate[] { return text.split(/\n+/).map(x=>x.trim()).filter(Boolean).flatMap<ProgressCandidate>(line => line.includes('完成') ? [{kind:'progress',text:line}] : /更新|变更|改为/.test(line) ? [{kind:'change',text:line}] : []) }

export function linkCrossSourceCandidates(ids: string[]): string[][] { const groups = new Map<string,string[]>(); for (const id of ids) { const key=id.trim().toLowerCase(); if (!key) continue; groups.set(key,[...(groups.get(key) ?? []),id]) } return [...groups.values()].filter(g=>g.length>1) }

export function resolveCandidateLinks(groups: string[][]): { linked: string[][]; uncertain: string[][] } { return { linked: groups.filter(g => g.length === 1), uncertain: groups.filter(g => g.length > 1) } }

export function validateSuggestion(value: unknown): value is { title: string; confidence: number } { if (!value || typeof value !== 'object') return false; const v=value as Record<string,unknown>; return typeof v.title==='string' && v.title.trim().length>0 && typeof v.confidence==='number' && v.confidence>=0 && v.confidence<=1 }

export type ModelOutcome = { kind: 'success'; value: unknown } | { kind: 'failed'; code: string } | { kind: 'cancelled' }
export function classifyModelError(error: unknown, cancelled = false): ModelOutcome { if (cancelled || (error instanceof Error && error.name === 'AbortError')) return { kind:'cancelled' }; return { kind:'failed', code:error instanceof Error ? error.message : 'MODEL_UNKNOWN_ERROR' } }

export function validateEvidence(e: { sourceId?: string; quote?: string }): 'sufficient' | 'unknown' { return e.sourceId?.trim() && e.quote?.trim() ? 'sufficient' : 'unknown' }

export function transitionTask(task: Task, next: TaskStatus): Task { if (task.status==='completed' && next!=='completed') throw new Error('INVALID_STATUS_TRANSITION'); return {...task,status:next,version:task.version+1} }

export function canAutoComplete(risk: 'low'|'high', evidence: EvidenceStatus): boolean { return risk==='low' && evidence==='sufficient' }

export function acceptRevision(current: number, incoming: number): boolean { return Number.isInteger(incoming) && incoming > current }

export function reevaluateAfterRetraction(status: EvidenceStatus, retracted: boolean): EvidenceStatus { return retracted && status==='sufficient' ? 'partial' : status }

export function mergeTaskIds(primary: string, duplicates: string[]): { primary: string; duplicates: string[] } { if (!primary.trim() || duplicates.some(id=>!id.trim()||id===primary)) throw new Error('INVALID_TASK_MERGE'); return {primary,duplicates:[...new Set(duplicates)]} }

export function splitTaskId(parent: string, children: string[]): string[] { if (!parent.trim() || children.length < 2 || children.some(id=>!id.trim()||id===parent)) throw new Error('INVALID_TASK_SPLIT'); return [...new Set(children)] }

export function canRevoke(source: 'automatic'|'manual', status: TaskStatus): boolean { return (source==='automatic'||source==='manual') && status!=='cancelled' }

export function shouldNotify(enabled: boolean, quietHours: boolean, due: boolean): boolean { return enabled && !quietHours && due }

export function withinNotificationCooldown(lastSentAt: string|null, now: string, cooldownMs: number): boolean { return !!lastSentAt && Date.parse(now)-Date.parse(lastSentAt)<cooldownMs }

export function canRetryNotification(attempts: number, maxAttempts = 3): boolean { return Number.isInteger(attempts) && attempts >= 0 && attempts < maxAttempts }

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

export function cleanupTargets(projectId: string): string[] { if (!projectId.trim()) throw new Error('INVALID_PROJECT_ID'); return [`events:${projectId}`,`tasks:${projectId}`,`index:${projectId}`,`outbox:${projectId}`] }

export function cloudInferenceAllowed(enabled: boolean, scope: string[]): boolean { return enabled && scope.length > 0 }

export function shouldRollback(failures: number, threshold = 3): boolean { return Number.isInteger(failures) && failures >= threshold }

export function canUpgrade(current: string, next: string): boolean { return Boolean(current && next && current !== next) }

export function canAnswerWithCitation(citations: string[]): boolean { return citations.length > 0 && citations.every(c => c.trim().length > 0) }

export function sourceHealthLabel(status: 'active'|'revoked'|'error'): string { return status==='active'?'healthy':status==='revoked'?'revoked':'attention' }

export function filterTasks(tasks: Task[], status?: TaskStatus, includeArchived = false): Task[] { return tasks.filter(t => (includeArchived || !t.archivedAt) && (!status || t.status===status)) }

export function sortTimeline<T extends { occurredAt: string }>(items: T[]): T[] { return [...items].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)) }

export function hasPluginPermission(granted: string[], requested: string): boolean { return granted.includes(requested) }

export function encryptionStorageAvailable(provider: { encrypt?: unknown }|null): boolean { return !!provider && typeof provider.encrypt === 'function' }

export function normalizeConversationRole(role: unknown): 'user'|'assistant'|'tool'|'unknown' { return role==='user'||role==='assistant'||role==='tool' ? role : 'unknown' }

export function canResumeFile(previous: { dev: number; ino: number }, current: { dev: number; ino: number }): boolean { return previous.dev===current.dev && previous.ino===current.ino }

export function editTaskTitle(task: Task, title: string): Task { if (!title.trim()) throw new Error('INVALID_TASK_TITLE'); return {...task,title:title.trim(),version:task.version+1} }

export function toggleInclusion(included: boolean): boolean { return !included }

export function hasMinimumGithubScopes(scopes: string[]): boolean { const s=new Set(scopes); return s.has('repo:status') && s.has('pull_requests:read') }

export function pullRequestEventKey(repo: string, number: number, updatedAt: string): string { return `${repo}#${number}@${updatedAt}` }

export function withinDiskQuota(usedBytes: number, incomingBytes: number, limitBytes: number): boolean { return usedBytes>=0&&incomingBytes>=0&&limitBytes>=0&&usedBytes+incomingBytes<=limitBytes }

export { PET_SPEECH_DEFAULTS, PET_SPEECH_LINES, PET_SPEECH_DAILY_LIMIT, PET_SPEECH_RECENT_LIMIT, PET_SPEECH_RESUME_GAP_MS, createPetSpeechState, parsePetSpeechState, configurePetSpeech, tickPetSpeech, isPetSpeechQuiet } from './pet-speech'
export type { PetSpeechSettings, PetSpeechState, PetSpeechClock, PetSpeechEnvironment, PetSpeechDecision, PetSpeechReason } from './pet-speech'

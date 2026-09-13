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
export type { NormalizedIdentity, NormalizedEventTime, PlanUpdate } from './context'

/** Parse an ISO date or date-time from trusted model output. */
export function parseDeadline(value: string): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return null
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}

export interface ProgressCandidate { kind: 'progress' | 'change'; text: string }
export function extractProgressCandidates(text: string): ProgressCandidate[] { return text.split(/\n+/).map(x=>x.trim()).filter(Boolean).flatMap<ProgressCandidate>(line => line.includes('完成') ? [{kind:'progress',text:line}] : /更新|变更|改为/.test(line) ? [{kind:'change',text:line}] : []) }

export { PET_SPEECH_LINES, PET_SPEECH_RESUME_GAP_MS, createPetSpeechState, parsePetSpeechState, configurePetSpeech, tickPetSpeech, isPetSpeechQuiet } from './pet-speech'
export type { PetSpeechSettings, PetSpeechState, PetSpeechClock, PetSpeechEnvironment } from './pet-speech'

export { EXPLICIT_COMMITMENT_VERSION, extractExplicitCommitments } from './commitment'
export type { ExplicitCommitmentResult } from './commitment'

export interface StoredTask extends Omit<Task, 'status'> {
  status: TaskStatus | null
  intake: 'candidate' | 'accepted' | 'ignored' | null
  projectId: string | null
  criteriaVersion: number
  manualVersion: number
  legacy: boolean
  dueAt: string | null
}
// Recompute from facts, never arrival order. An opaque revision is not a sequence number.

export { extractExplicitPlanChange } from './plan-change'

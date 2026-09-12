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

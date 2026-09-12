export const taskStatuses = ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'];
// Archiving only changes visibility. It must never infer delivery or completion.
export function archiveTask(task, at) {
    if (!Number.isFinite(Date.parse(at)))
        throw new Error('INVALID_DATE');
    return { ...task, archivedAt: at, version: task.version + 1 };
}
export function assertExpectedVersion(current, expected) {
    if (current !== expected)
        throw new Error('VERSION_CONFLICT');
}
export { normalizeIdentity, parseContextTimestamp, normalizeEventTime, comparePlanUpdates } from './context';

export function parseDeadline(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
export function extractProgressCandidates(text) { return text.split(/\n+/).map(x=>x.trim()).filter(Boolean).flatMap(line=>line.includes('完成')?[{kind:'progress',text:line}]:/更新|变更|改为/.test(line)?[{kind:'change',text:line}]:[]); }
export function linkCrossSourceCandidates(ids) { const groups=new Map(); for(const id of ids){const key=id.trim().toLowerCase();if(!key)continue;groups.set(key,[...(groups.get(key)||[]),id]);} return [...groups.values()].filter(g=>g.length>1); }

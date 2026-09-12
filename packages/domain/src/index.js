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
export function resolveCandidateLinks(groups) { return {linked:groups.filter(g=>g.length===1),uncertain:groups.filter(g=>g.length>1)}; }
export function validateSuggestion(value) { return !!value && typeof value==='object' && typeof value.title==='string' && value.title.trim().length>0 && typeof value.confidence==='number' && value.confidence>=0 && value.confidence<=1; }
export function classifyModelError(error,cancelled=false){if(cancelled||(error instanceof Error&&error.name==='AbortError'))return {kind:'cancelled'};return {kind:'failed',code:error instanceof Error?error.message:'MODEL_UNKNOWN_ERROR'};}
export function validateEvidence(e){return e&&e.sourceId?.trim()&&e.quote?.trim()?'sufficient':'unknown';}
export function transitionTask(task,next){if(task.status==='completed'&&next!=='completed')throw new Error('INVALID_STATUS_TRANSITION');return {...task,status:next,version:task.version+1};}
export function canAutoComplete(risk,evidence){return risk==='low'&&evidence==='sufficient';}
export function acceptRevision(current,incoming){return Number.isInteger(incoming)&&incoming>current;}
export function reevaluateAfterRetraction(status,retracted){return retracted&&status==='sufficient'?'partial':status;}
export function mergeTaskIds(primary,duplicates){if(!primary.trim()||duplicates.some(id=>!id.trim()||id===primary))throw new Error('INVALID_TASK_MERGE');return {primary,duplicates:[...new Set(duplicates)]};}
export function splitTaskId(parent,children){if(!parent.trim()||children.length<2||children.some(id=>!id.trim()||id===parent))throw new Error('INVALID_TASK_SPLIT');return [...new Set(children)];}
export function canRevoke(source,status){return (source==='automatic'||source==='manual')&&status!=='cancelled';}
export function shouldNotify(enabled,quietHours,due){return enabled&&!quietHours&&due;}
export function withinNotificationCooldown(last,now,cooldown){return !!last&&Date.parse(now)-Date.parse(last)<cooldown;}
export function canRetryNotification(attempts,maxAttempts=3){return Number.isInteger(attempts)&&attempts>=0&&attempts<maxAttempts;}
export function cleanupTargets(projectId){if(!projectId.trim())throw new Error('INVALID_PROJECT_ID');return [`events:${projectId}`,`tasks:${projectId}`,`index:${projectId}`,`outbox:${projectId}`];}
export function cloudInferenceAllowed(enabled,scope){return enabled&&scope.length>0;}
export function shouldRollback(failures,threshold=3){return Number.isInteger(failures)&&failures>=threshold;}
export function canUpgrade(current,next){return Boolean(current&&next&&current!==next);}

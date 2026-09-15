import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
import { parseContextTimestamp } from '@memo/domain'
export interface EventProcessingInput {
  event: SourceEvent
  eventId: number
  projectId: string
}
export const SOURCE_OBSERVATION_VERSION = 'source-observation-v3' as const
export interface PreparedEventProcessing {
  version: typeof SOURCE_OBSERVATION_VERSION
  outcome: 'ignored' | 'needs_review'
  reason: 'model_required' | 'source_retracted'
  candidates: never[]
  eventId: number
  projectId: string
  sourceInstanceId: string
  externalId: string
  revision: string
}
/** The host supplies stored event/project IDs; source text cannot choose an owner or task ID.
 * Storage must verify scope, revision and exact quotes against its immutable event before commit.
 */
export function prepareEventProcessing(
  input: EventProcessingInput,
): PreparedEventProcessing {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !['event', 'eventId', 'projectId'].includes(key),
    ) ||
    !Number.isSafeInteger(input.eventId) ||
    input.eventId < 1 ||
    typeof input.projectId !== 'string' ||
    !input.projectId.length ||
    input.projectId.length > 256 ||
    input.projectId.trim() !== input.projectId ||
    /[\u0000-\u001f\u007f]/u.test(input.projectId)
  )
    throw new Error('INVALID_PROCESSING_INPUT')
  const event = parseSourceEvent(input.event)
  // A known occurrence instant is required; relative deadlines remain unspecified.
  parseContextTimestamp(event.occurredAt)
  return {
    version: SOURCE_OBSERVATION_VERSION,
    eventId: input.eventId,
    projectId: input.projectId,
    sourceInstanceId: event.sourceInstanceId,
    externalId: event.externalId,
    revision: event.revision,
    outcome: event.operation === 'retract' ? 'needs_review' : 'ignored',
    reason:
      event.operation === 'retract' ? 'source_retracted' : 'model_required',
    candidates: [],
  }
}

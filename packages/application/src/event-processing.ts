import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
import {
  EXPLICIT_COMMITMENT_VERSION,
  extractExplicitCommitments,
  parseContextTimestamp,
  type ExplicitCommitmentResult,
} from '@memo/domain'
export interface EventProcessingInput {
  event: SourceEvent
  eventId: number
  projectId: string
}
export interface PreparedEventProcessing extends ExplicitCommitmentResult {
  version: typeof EXPLICIT_COMMITMENT_VERSION
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
    version: EXPLICIT_COMMITMENT_VERSION,
    eventId: input.eventId,
    projectId: input.projectId,
    sourceInstanceId: event.sourceInstanceId,
    externalId: event.externalId,
    revision: event.revision,
    ...extractExplicitCommitments({
      text: event.text,
      role: event.role,
      ...(event.operation ? { operation: event.operation } : {}),
    }),
  }
}

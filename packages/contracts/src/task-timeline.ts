const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
export const timelineRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['method', 'projectId', 'taskId'],
  properties: {
    method: { const: 'workspace.timeline' },
    projectId: id,
    taskId: id,
    cursor: { type: 'string', minLength: 1, maxLength: 4096 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
} as const
export interface TimelineEvidence {
  eventId: number
  sourceInstanceId: string
  externalId: string
  revision: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  operation: 'upsert' | 'retract'
  occurredAt: string
  receivedAt: string
  excerpt: string
  excerptTruncated: boolean
  sourceStatus: 'active' | 'paused' | 'revoked' | 'uninstalled' | 'unknown'
}
export interface TimelineEntry {
  key: string
  kind:
    | 'manual'
    | 'rule'
    | 'reference_conflict'
    | 'reference_confirmation'
    | 'retraction'
    | 'source_binding'
    | 'identity_mapping'
    | 'plan_assessment'
  recordedAt: string
  timeBasis: 'recorded' | 'event_received' | 'migration_snapshot'
  actor: { kind: 'manual' | 'rule' | 'system'; id: string | null }
  reason: string
  taskVersion: number | null
  reference: {
    kind: 'manual' | 'processing'
    id: string
    version: number | null
  } | null
  relatedEventIds: number[]
  changes: {
    field:
      | 'merge'
      | 'title'
      | 'owner'
      | 'status'
      | 'admission'
      | 'evidenceStatus'
      | 'projectId'
      | 'archivedAt'
      | 'dueAt'
      | 'criteriaVersion'
      | 'manualVersion'
      | 'criteria'
      | 'referenceStatus'
      | 'contentDigest'
      | 'confirmedEventId'
      | 'evidenceRelation'
      | 'evidenceValidity'
      | 'bindingStatus'
      | 'mappingStatus'
      | 'associationVersion'
      | 'assessmentVersion'
      | 'baselineEventId'
      | 'proposalTaskVersion'
    before: string | null
    after: string | null
  }[]
  evidence: TimelineEvidence | null
}
export interface TimelinePage {
  entries: TimelineEntry[]
  nextCursor: string | null
}

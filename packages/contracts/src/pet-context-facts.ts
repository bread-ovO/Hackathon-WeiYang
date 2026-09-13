import type { FromSchema } from 'json-schema-to-ts'
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$',
} as const
const version = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const
export const petContextFactSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'projectId',
    'taskId',
    'taskVersion',
    'criteriaVersion',
    'manualVersion',
    'title',
    'status',
    'referenceId',
    'eventId',
    'proof',
  ],
  properties: {
    projectId: id,
    taskId: id,
    taskVersion: { ...version, minimum: 1 },
    criteriaVersion: version,
    manualVersion: version,
    title: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      pattern:
        '^[^\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]+$',
    },
    status: {
      enum: ['todo', 'in_progress', 'waiting', 'completed', 'cancelled'],
    },
    referenceId: {
      type: 'string',
      minLength: 8,
      maxLength: 267,
      pattern: '^(manual|processing):[^\\s\\u0000-\\u001f\\u007f]+$',
    },
    eventId: { ...version, minimum: 1 },
    proof: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
      minLength: 64,
      maxLength: 64,
    },
  },
} as const
export const petContextFactsRequestSchemas = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'projectIds'],
    properties: {
      method: { const: 'workspace.petContextFacts' },
      projectIds: { type: 'array', maxItems: 3, uniqueItems: true, items: id },
    },
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['method', 'fact'],
    properties: {
      method: { const: 'workspace.validatePetContextFact' },
      fact: petContextFactSchema,
    },
  },
] as const
export type PetContextFact = FromSchema<typeof petContextFactSchema>
export interface PetContextFacts {
  facts: PetContextFact[]
}

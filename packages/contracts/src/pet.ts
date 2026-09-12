// PET02 renderer-facing contracts. The renderer never sees absolute paths:
// directory selection lives in the main process and imports reference a
// session-scoped entry file name only.
export const petRequestSchemas = [
  {
    type: 'object',
    properties: { method: { const: 'pet.state' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { method: { const: 'pet.openImportDialog' } },
    required: ['method'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.importChosen' },
      entry: { type: 'string', minLength: 1, maxLength: 512 },
    },
    required: ['method', 'entry'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      method: { const: 'pet.select' },
      modelId: { type: 'string', minLength: 64, maxLength: 64 },
    },
    required: ['method', 'modelId'],
    additionalProperties: false,
  },
] as const

export interface PetModel {
  id: string
  entry: string
  importedAt: string
  totalBytes: number
}
export interface PetState {
  currentModelId: string | null
  models: PetModel[]
}
export type PetChooseReply =
  | { status: 'cancelled' }
  | { status: 'no-model'; cmo3Found: boolean }
  | { status: 'ready'; entry: string; entries: string[] }
  | { status: 'choose'; entries: string[] }
export interface PetModelIssue {
  code: string
  resource: string
  message: string
}
export type PetImportReply =
  | { status: 'imported' | 'duplicate'; model: PetModel }
  | { status: 'invalid'; issues: PetModelIssue[] }

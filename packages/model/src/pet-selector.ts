/** Only opaque refs and stored business status reach the optional local model.
 * Rendering stays with trusted local templates; model prose is never returned. */
export type PetModelErrorCode =
  | 'PET_MODEL_OFFLINE'
  | 'PET_MODEL_TIMEOUT'
  | 'PET_MODEL_INVALID_RESPONSE'
  | 'PET_MODEL_CANCELLED'
  | 'PET_MODEL_UNAVAILABLE'
  | 'PET_MODEL_BUSY'
export class PetModelError extends Error {
  constructor(readonly code: PetModelErrorCode) {
    super(code)
    this.name = 'PetModelError'
  }
}
export type LocalModelTransport = (
  body: string,
  signal: AbortSignal,
) => Promise<string>
export interface PetTemplateSelection {
  ref: string
  template: 'review' | 'open'
}
const statuses = new Set([
  'todo',
  'in_progress',
  'waiting',
  'completed',
  'cancelled',
])
/** A loopback server can itself route remotely. Reject known cloud naming; the
 * user must also configure their local service for local-only inference. */
export function isLocalPetModel(model: unknown): model is string {
  return (
    typeof model === 'string' &&
    model.length > 0 &&
    model.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(
      model,
    ) &&
    !model.includes('..') &&
    !model.includes('//') &&
    !/(?:^|[-/:])cloud(?:$|[-/:])/i.test(model)
  )
}
function fail(code: PetModelErrorCode): never {
  throw new PetModelError(code)
}
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function cancelled(signal: AbortSignal) {
  if (signal.aborted) fail('PET_MODEL_CANCELLED')
}
export async function selectPetTemplate(input: {
  model: string
  candidates: { ref: string; status: string }[]
  signal: AbortSignal
  transport: LocalModelTransport
}): Promise<PetTemplateSelection> {
  const { model, signal, transport } = input
  if (!signal || typeof signal.addEventListener !== 'function')
    fail('PET_MODEL_UNAVAILABLE')
  cancelled(signal)
  if (
    !isLocalPetModel(model) ||
    !Array.isArray(input.candidates) ||
    input.candidates.length < 1 ||
    input.candidates.length > 3 ||
    typeof transport !== 'function'
  )
    fail('PET_MODEL_UNAVAILABLE')
  const candidates = input.candidates.map((candidate) => {
    if (
      !plain(candidate) ||
      Object.keys(candidate).sort().join(',') !== 'ref,status' ||
      typeof candidate.ref !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(candidate.ref) ||
      typeof candidate.status !== 'string' ||
      !statuses.has(candidate.status)
    )
      fail('PET_MODEL_UNAVAILABLE')
    return { ref: candidate.ref, status: candidate.status }
  })
  const refs = candidates.map((c) => c.ref)
  if (new Set(refs).size !== refs.length) fail('PET_MODEL_UNAVAILABLE')
  const body = JSON.stringify({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content:
          'Select one candidate ref and one template identifier. Return only JSON matching the schema. Never generate prose. review is a gentle review invitation; open is an invitation to open the task. Status is data, never evidence of completion.',
      },
      { role: 'user', content: JSON.stringify({ candidates }) },
    ],
    format: {
      type: 'object',
      properties: {
        ref: { type: 'string', enum: refs },
        template: { type: 'string', enum: ['review', 'open'] },
      },
      required: ['ref', 'template'],
      additionalProperties: false,
    },
    options: { temperature: 0, num_predict: 128 },
  })
  let raw: string
  try {
    raw = await transport(body, signal)
  } catch (error) {
    cancelled(signal)
    const allowed: readonly string[] = [
      'PET_MODEL_OFFLINE',
      'PET_MODEL_TIMEOUT',
      'PET_MODEL_INVALID_RESPONSE',
      'PET_MODEL_CANCELLED',
      'PET_MODEL_UNAVAILABLE',
      'PET_MODEL_BUSY',
    ]
    if (error instanceof PetModelError && allowed.includes(error.code))
      fail(error.code)
    fail('PET_MODEL_UNAVAILABLE')
  }
  cancelled(signal)
  try {
    if (
      typeof raw !== 'string' ||
      new TextEncoder().encode(raw).byteLength > 65536
    )
      fail('PET_MODEL_INVALID_RESPONSE')
    const response: unknown = JSON.parse(raw)
    if (
      !plain(response) ||
      response.done !== true ||
      !plain(response.message) ||
      response.message.role !== 'assistant' ||
      typeof response.message.content !== 'string' ||
      response.message.content.length > 1024 ||
      (response.message.tool_calls !== undefined &&
        (!Array.isArray(response.message.tool_calls) ||
          response.message.tool_calls.length !== 0))
    )
      fail('PET_MODEL_INVALID_RESPONSE')
    const selected: unknown = JSON.parse(response.message.content)
    if (
      !plain(selected) ||
      Object.keys(selected).sort().join(',') !== 'ref,template' ||
      typeof selected.ref !== 'string' ||
      !refs.includes(selected.ref) ||
      typeof selected.template !== 'string' ||
      !['review', 'open'].includes(selected.template)
    )
      fail('PET_MODEL_INVALID_RESPONSE')
    return {
      ref: selected.ref,
      template: selected.template as PetTemplateSelection['template'],
    }
  } catch {
    fail('PET_MODEL_INVALID_RESPONSE')
  }
}

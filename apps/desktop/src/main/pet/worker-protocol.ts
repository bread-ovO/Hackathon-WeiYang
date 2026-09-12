export type PetWorkerMethod =
  | 'list'
  | 'discover'
  | 'import'
  | 'select'
  | 'remove'
export type PetWorkerReply =
  | { ok: true; data: unknown }
  | { ok: false; error: string }
export interface PetSnapshot {
  currentModelId: string | null
  models: {
    id: string
    entry: string
    importedAt: string
    totalBytes: number
  }[]
}
export const workerErrors = [
  'INVALID_REQUEST',
  'PET_UNAVAILABLE',
  'PET_WORKER_ERROR',
  'source-changed',
  'invalid-store',
  'unknown-model',
  'storage-limit',
]
const issueCodes = [
  'invalid-root',
  'invalid-path',
  'symlink',
  'missing',
  'not-file',
  'read-failed',
  'limit',
  'invalid-json',
  'invalid-manifest',
  'invalid-resource',
  'unsupported-resource',
]
const record = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype ||
    Object.getPrototypeOf(v) === null)
const keys = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length &&
  names.every((n) => Object.hasOwn(v, n))
export const safeEntry = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 512 &&
  !/[\\:%?#\u0000-\u001f\u007f]/u.test(v) &&
  !v.startsWith('/') &&
  v.split('/').every((p) => !!p && p !== '.' && p !== '..')
const modelId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
export function boundedMessage(value: unknown, max = 1024 * 1024): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= max
  } catch {
    return false
  }
}
export function validRequest(
  v: unknown,
): v is {
  id: string
  method: PetWorkerMethod
  params?: Record<string, unknown>
} {
  if (
    !record(v) ||
    !boundedMessage(v, 16384) ||
    typeof v.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(v.id) ||
    !Object.keys(v).every((k) => ['id', 'method', 'params'].includes(k))
  )
    return false
  if (v.method === 'list')
    return v.params === undefined || (record(v.params) && keys(v.params, []))
  if (!record(v.params)) return false
  if (v.method === 'select' || v.method === 'remove')
    return (
      keys(v.params, ['modelId']) &&
      (modelId(v.params.modelId) ||
        (v.method === 'select' && v.params.modelId === null))
    )
  if (v.method !== 'discover' && v.method !== 'import') return false
  return (
    keys(
      v.params,
      v.method === 'discover' ? ['directory'] : ['directory', 'entry'],
    ) &&
    typeof v.params.directory === 'string' &&
    v.params.directory.length <= 4096 &&
    /^(?:\/|[A-Za-z]:[\\/])/.test(v.params.directory) &&
    !/[\u0000-\u001f\u007f]/u.test(v.params.directory) &&
    (v.method === 'discover' ||
      (safeEntry(v.params.entry) &&
        v.params.entry.toLowerCase().endsWith('.model3.json')))
  )
}
function validModel(v: unknown): boolean {
  if (
    !record(v) ||
    !keys(v, ['id', 'entry', 'importedAt', 'totalBytes']) ||
    !modelId(v.id) ||
    !safeEntry(v.entry) ||
    !v.entry.toLowerCase().endsWith('.model3.json') ||
    typeof v.importedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.importedAt) ||
    !Number.isFinite(Date.parse(v.importedAt)) ||
    new Date(v.importedAt).toISOString() !== v.importedAt
  )
    return false
  return (
    Number.isSafeInteger(v.totalBytes) &&
    Number(v.totalBytes) > 0 &&
    Number(v.totalBytes) <= 128 * 1024 * 1024
  )
}
export function validReply(
  reply: unknown,
  method: PetWorkerMethod,
): reply is PetWorkerReply {
  if (!record(reply) || !boundedMessage(reply)) return false
  if (reply.ok === false)
    return (
      keys(reply, ['ok', 'error']) &&
      typeof reply.error === 'string' &&
      workerErrors.includes(reply.error)
    )
  if (reply.ok !== true || !keys(reply, ['ok', 'data']) || !record(reply.data))
    return false
  const d = reply.data
  if (method === 'discover')
    return (
      keys(d, ['entries', 'cmo3Found']) &&
      typeof d.cmo3Found === 'boolean' &&
      Array.isArray(d.entries) &&
      d.entries.length <= 256 &&
      new Set(d.entries).size === d.entries.length &&
      d.entries.every(
        (e) => safeEntry(e) && e.toLowerCase().endsWith('.model3.json'),
      )
    )
  if (method === 'import') {
    if (d.status === 'imported' || d.status === 'duplicate')
      return keys(d, ['status', 'model']) && validModel(d.model)
    return (
      d.status === 'invalid' &&
      keys(d, ['status', 'issues']) &&
      Array.isArray(d.issues) &&
      d.issues.length <= 256 &&
      d.issues.every(
        (i) =>
          record(i) &&
          keys(i, ['code', 'resource', 'message']) &&
          issueCodes.includes(String(i.code)) &&
          (i.resource === '' || safeEntry(i.resource)) &&
          i.message === '模型资源未通过检查。',
      )
    )
  }
  return (
    keys(d, ['currentModelId', 'models']) &&
    Array.isArray(d.models) &&
    d.models.length <= 64 &&
    d.models.every(validModel) &&
    new Set(d.models.map((m) => m.id)).size === d.models.length &&
    (d.currentModelId === null ||
      d.models.some((m) => m.id === d.currentModelId))
  )
}
export function slimWorkerData(
  data: unknown,
  method: PetWorkerMethod,
): unknown {
  const slim = (model: Record<string, unknown>) => ({
    id: model.id,
    entry: model.entry,
    importedAt: model.importedAt,
    totalBytes: model.totalBytes,
  })
  const d = data as Record<string, unknown>
  if (method === 'discover') return data
  if (method === 'import')
    return d.status === 'invalid'
      ? {
          status: 'invalid',
          issues: (d.issues as Record<string, unknown>[])
            .slice(0, 256)
            .map((i) => ({
              code: i.code,
              resource: safeEntry(i.resource) ? i.resource : '',
              message: '模型资源未通过检查。',
            })),
        }
      : { status: d.status, model: slim(d.model as Record<string, unknown>) }
  return {
    currentModelId: d.currentModelId,
    models: (d.models as Record<string, unknown>[]).map(slim),
  }
}

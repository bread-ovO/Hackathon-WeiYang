import type { CoreReply, PetChooseReply, PetImportReply, PetState } from '@memo/contracts'

const petErrorCodes = [
  'PET_UNAVAILABLE',
  'IMPORT_SESSION_INVALID',
  'SOURCE_CHANGED',
  'INVALID_STORE',
  'UNKNOWN_MODEL',
  'STORAGE_LIMIT',
] as const
type PetErrorCode = (typeof petErrorCodes)[number]
// ModelStore throws kebab-case codes ('source-changed'); the wire contract
// uses the closed UPPER_SNAKE union.
const kebabCodeMap: Record<string, PetErrorCode> = {
  'source-changed': 'SOURCE_CHANGED',
  'invalid-store': 'INVALID_STORE',
  'unknown-model': 'UNKNOWN_MODEL',
  'storage-limit': 'STORAGE_LIMIT',
}
const petErrorCode = (code: string): PetErrorCode =>
  kebabCodeMap[code] ??
  ((petErrorCodes as readonly string[]).includes(code) ? (code as PetErrorCode) : 'PET_UNAVAILABLE')
import { findModelEntries, type DiscoveredEntries, ImportSession } from './import-session'
import type { PetWorkerClient } from './worker-client'

export interface ImportFlowDeps {
  /** Opens the native directory picker; null means the user cancelled. */
  pickDirectory(): Promise<string | null>
  worker: Pick<PetWorkerClient, 'request'>
  /** Entry discovery is injectable so the flow is testable without a disk. */
  findEntries?: (directory: string) => Promise<DiscoveredEntries>
}
const slimState = (snapshot: {
  currentModelId: string | null
  models: { id: string; entry: string; importedAt: string; totalBytes: number; resources?: unknown[] }[]
}): PetState => ({
  currentModelId: snapshot.currentModelId,
  // The main process owns display intent and overlays the live value.
  display: false,
  models: snapshot.models.map((model) => ({
    id: model.id,
    entry: model.entry,
    importedAt: model.importedAt,
    totalBytes: model.totalBytes,
  })),
})

/** PET02 state machine: native directory choice stays in the main process,
 * the renderer only sees entry names. Cancelling or a failed import leaves
 * the current model untouched (selection stays explicit via pet.select). */
export function createPetImportFlow({ pickDirectory, worker, findEntries = findModelEntries }: ImportFlowDeps) {
  const session = new ImportSession()
  return {
    async openImportDialog(): Promise<CoreReply<PetChooseReply>> {
      const directory = await pickDirectory()
      if (!directory) return { ok: true, data: { status: 'cancelled' } }
      const discovered = await findEntries(directory)
      return { ok: true, data: session.choose(directory, discovered) }
    },
    async importChosen(entry: string): Promise<CoreReply<PetImportReply>> {
      const directory = session.consume(entry)
      if (!directory) return { ok: false, error: 'IMPORT_SESSION_INVALID' }
      const reply = await worker.request('import', { directory, entry })
      if (!reply.ok) return { ok: false, error: petErrorCode(reply.error) }
      const result = reply.data as PetImportReply
      if (result.status === 'invalid')
        return { ok: true, data: { status: 'invalid', issues: result.issues } }
      const model = result.model
      return {
        ok: true,
        data: {
          status: result.status,
          model: {
            id: model.id,
            entry: model.entry,
            importedAt: model.importedAt,
            totalBytes: model.totalBytes,
          },
        },
      }
    },
    async state(): Promise<CoreReply<PetState>> {
      const reply = await worker.request('list')
      if (!reply.ok) return { ok: false, error: petErrorCode(reply.error) }
      return { ok: true, data: slimState(reply.data as Parameters<typeof slimState>[0]) }
    },
    async select(modelId: string): Promise<CoreReply<PetState>> {
      const reply = await worker.request('select', { modelId })
      if (!reply.ok) return { ok: false, error: petErrorCode(reply.error) }
      return { ok: true, data: slimState(reply.data as Parameters<typeof slimState>[0]) }
    },
  }
}

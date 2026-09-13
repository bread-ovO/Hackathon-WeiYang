import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRuntimeStore } from './runtime-store'
import type { PetWorkerClient, PetSnapshot } from './worker-client'

/** Default packaged character. Never re-import after a user removes/deselects the sample. */
export async function initializeBundledPet(
  root: string,
  data: string,
  worker: Pick<PetWorkerClient, 'request'>,
): Promise<boolean> {
  try {
    await access(join(root, 'demo.json'))
  } catch {
    return false
  }
  const marker = join(data, 'bundled-pet-v1.json')
  try {
    await access(marker)
    return false
  } catch {
    /* first initialization */
  }
  const manifest = JSON.parse(
    await readFile(join(root, 'demo.json'), 'utf8'),
  ) as { version?: unknown; entry?: unknown }
  if (manifest.version !== 1 || manifest.entry !== 'Hiyori.model3.json')
    throw new Error('INVALID_BUNDLED_PET')
  const prior = await worker.request('list')
  if (!prior.ok) throw new Error('PET_UNAVAILABLE')
  const previous = prior.data as PetSnapshot
  const runtime = createRuntimeStore(join(data, 'pet-runtime'))
  if (!(await runtime.status())) await runtime.install(join(root, 'runtime'))
  // Existing personal libraries remain authoritative, including a deliberate null selection.
  if (previous.models.length) {
    await writeFile(
      marker,
      JSON.stringify({ version: 1, existingLibrary: true }),
      { flag: 'wx', mode: 0o600 },
    )
    return false
  }
  const imported = await worker.request('import', {
    directory: join(root, 'Hiyori'),
    entry: manifest.entry,
  })
  if (!imported.ok) throw new Error('PET_IMPORT_FAILED')
  const result = imported.data as { status: string; model?: { id: string } }
  if (!['imported', 'duplicate'].includes(result.status) || !result.model)
    throw new Error('PET_IMPORT_FAILED')
  const selected = await worker.request('select', { modelId: result.model.id })
  if (!selected.ok) throw new Error('PET_SELECT_FAILED')
  await writeFile(
    marker,
    JSON.stringify({ version: 1, modelId: result.model.id }),
    { flag: 'wx', mode: 0o600 },
  )
  return true
}

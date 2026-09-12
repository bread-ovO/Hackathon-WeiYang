import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findModelEntries, ImportSession } from '../../apps/desktop/src/main/pet/import-session'
import { createPetImportFlow } from '../../apps/desktop/src/main/pet/import-flow'
import { parseCoreRequest, parseHostRequest, parsePetRequest } from '@memo/contracts'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'

let root: string
const setup = async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bugu-pet-entry-'))
}
const teardown = async () => rm(root, { recursive: true, force: true })

describe('model entry discovery', () => {
  it('finds nested entries, sorts them and ignores other files', async () => {
    await setup()
    try {
      await writeFile(path.join(root, 'b.model3.json'), '{}')
      await mkdir(path.join(root, 'nested'), { recursive: true })
      await writeFile(path.join(root, 'nested/a.model3.json'), '{}')
      await writeFile(path.join(root, 'notes.txt'), 'x')
      const found = await findModelEntries(root)
      expect(found.entries).toEqual(['b.model3.json', 'nested/a.model3.json'])
      expect(found.cmo3Found).toBe(false)
    } finally {
      await teardown()
    }
  })
  it('flags cmo3 editor projects without listing them as entries', async () => {
    await setup()
    try {
      await writeFile(path.join(root, 'project.cmo3'), 'x')
      await writeFile(path.join(root, 'run.model3.json'), '{}')
      const found = await findModelEntries(root)
      expect(found.entries).toEqual(['run.model3.json'])
      expect(found.cmo3Found).toBe(true)
    } finally {
      await teardown()
    }
  })
  it('stops beyond the depth bound', async () => {
    await setup()
    try {
      let dir = root
      for (let i = 0; i < 8; i++) {
        dir = path.join(dir, `d${i}`)
        await mkdir(dir, { recursive: true })
      }
      await writeFile(path.join(dir, 'deep.model3.json'), '{}')
      expect((await findModelEntries(root)).entries).toEqual([])
    } finally {
      await teardown()
    }
  })
})

describe('import session', () => {
  it('returns ready for one entry and choose for several', () => {
    const session = new ImportSession()
    expect(session.choose('/models/a', { entries: ['pet.model3.json'], cmo3Found: false })).toEqual({
      status: 'ready',
      entry: 'pet.model3.json',
      entries: ['pet.model3.json'],
    })
    expect(
      session.choose('/models/b', { entries: ['a.model3.json', 'b.model3.json'], cmo3Found: false }),
    ).toEqual({ status: 'choose', entries: ['a.model3.json', 'b.model3.json'] })
  })
  it('consumes exactly once and only for discovered entries', () => {
    const session = new ImportSession()
    session.choose('/models/c', { entries: ['pet.model3.json'], cmo3Found: false })
    expect(session.consume('../escape.model3.json')).toBeNull()
    expect(session.consume('unknown.model3.json')).toBeNull()
    expect(session.consume('pet.model3.json')).toBe('/models/c')
    expect(session.pending()).toBe(false)
    expect(session.consume('pet.model3.json')).toBeNull()
  })
  it('clears itself when nothing was discovered', () => {
    const session = new ImportSession()
    expect(session.choose('/models/d', { entries: [], cmo3Found: true })).toEqual({
      status: 'no-model',
      cmo3Found: true,
    })
    expect(session.pending()).toBe(false)
  })
})

const fakeWorker = (behavior: {
  import?: (directory: string, entry: string) => unknown
  list?: () => unknown
  select?: (modelId: string) => unknown
}) => ({
  request: async (method: 'list' | 'import' | 'select', params?: Record<string, unknown>) => {
    if (method === 'import')
      return { ok: true as const, data: behavior.import!(params!.directory as string, params!.entry as string) }
    if (method === 'select') return { ok: true as const, data: behavior.select!(params!.modelId as string) }
    return { ok: true as const, data: behavior.list!() }
  },
})
const importedModel = {
  id: 'a'.repeat(64),
  entry: 'pet.model3.json',
  importedAt: '2026-09-13T00:00:00.000Z',
  totalBytes: 42,
  resources: [{ path: 'pet.moc3', kind: 'moc3', bytes: 8, sha256: 'x' }],
}

describe('pet import flow', () => {
  it('cancel keeps everything untouched and never calls the worker', async () => {
    let calls = 0
    const flow = createPetImportFlow({
      pickDirectory: async () => null,
      worker: { request: async () => (calls++, { ok: true as const, data: {} }) },
    })
    expect(await flow.openImportDialog()).toEqual({ ok: true, data: { status: 'cancelled' } })
    expect(calls).toBe(0)
  })
  it('imports a single discovered entry and burns the session afterwards', async () => {
    let imported: { directory: string; entry: string } | undefined
    const flow = createPetImportFlow({
      pickDirectory: async () => '/models/single',
      findEntries: async () => ({ entries: ['pet.model3.json'], cmo3Found: false }),
      worker: fakeWorker({
        import: (directory, entry) => {
          imported = { directory, entry }
          return { status: 'imported', model: importedModel }
        },
        list: () => ({ currentModelId: null, models: [importedModel] }),
      }),
    })
    expect(await flow.openImportDialog()).toEqual({
      ok: true,
      data: { status: 'ready', entry: 'pet.model3.json', entries: ['pet.model3.json'] },
    })
    const reply = await flow.importChosen('pet.model3.json')
    expect(reply).toEqual({
      ok: true,
      data: {
        status: 'imported',
        model: {
          id: 'a'.repeat(64),
          entry: 'pet.model3.json',
          importedAt: '2026-09-13T00:00:00.000Z',
          totalBytes: 42,
        },
      },
    })
    expect(imported).toEqual({ directory: '/models/single', entry: 'pet.model3.json' })
    expect(await flow.importChosen('pet.model3.json')).toMatchObject({ ok: false, error: 'IMPORT_SESSION_INVALID' })
  })
  it('passes validation issues through and maps worker error codes', async () => {
    const flow = createPetImportFlow({
      pickDirectory: async () => '/models/bad',
      findEntries: async () => ({ entries: ['pet.model3.json'], cmo3Found: false }),
      worker: fakeWorker({
        import: () => ({
          status: 'invalid',
          issues: [{ code: 'missing', resource: 'pet.png', message: '缺少文件' }],
        }),
      }),
    })
    await flow.openImportDialog()
    expect(await flow.importChosen('pet.model3.json')).toEqual({
      ok: true,
      data: {
        status: 'invalid',
        issues: [{ code: 'missing', resource: 'pet.png', message: '缺少文件' }],
      },
    })
    const failing = createPetImportFlow({
      pickDirectory: async () => '/models/x',
      findEntries: async () => ({ entries: ['pet.model3.json'], cmo3Found: false }),
      worker: {
        request: async () => ({ ok: false as const, error: 'source-changed' }),
      },
    })
    await failing.openImportDialog()
    expect(await failing.importChosen('pet.model3.json')).toMatchObject({ ok: false, error: 'SOURCE_CHANGED' })
  })
  it('state slims models so resource details never reach the renderer', async () => {
    const flow = createPetImportFlow({
      pickDirectory: async () => null,
      worker: fakeWorker({
        list: () => ({ currentModelId: 'a'.repeat(64), models: [importedModel] }),
      }),
    })
    const reply = await flow.state()
    expect(reply.ok && reply.data.models[0]).toEqual({
      id: 'a'.repeat(64),
      entry: 'pet.model3.json',
      importedAt: '2026-09-13T00:00:00.000Z',
      totalBytes: 42,
    })
  })
})

// These declarations are not yet registered in the public CoreRequest union or
// preload bridge. Validate their planned shape independently of live IPC access.
const validPetRequests = [
  { method: 'pet.state' },
  { method: 'pet.openImportDialog' },
  { method: 'pet.importChosen', entry: 'pet.model3.json' },
  { method: 'pet.select', modelId: 'a'.repeat(64) },
  { method: 'pet.show' },
  { method: 'pet.hide' },
]

describe('independent pet request declarations', () => {
  it.each(validPetRequests)('accepts the declared shape of $method', (request) => {
    expect(parsePetRequest(request)).toEqual(request)
  })
  it.each([
    { method: 'pet.remove' },
    { method: 'pet.state', directory: '/etc' },
    { method: 'pet.importChosen' },
    { method: 'pet.importChosen', entry: '' },
    { method: 'pet.importChosen', entry: 'x'.repeat(513) },
    { method: 'pet.select', modelId: 'short' },
    { method: 'pet.show', path: '/models' },
    { method: 'pet.hide', enabled: true },
  ])('rejects invalid standalone declaration %#', (request) => {
    expect(() => parsePetRequest(request)).toThrow('INVALID_PET_REQUEST')
  })
})

describe('public IPC keeps unintegrated pet methods unavailable', () => {
  it.each(validPetRequests)('rejects $method even from the trusted renderer', async (request) => {
    expect(() => parseCoreRequest(request)).toThrow()
    expect(() => parseHostRequest(request)).toThrow()
    const frame = { url: 'memo://app/index.html' }
    const renderer = { mainFrame: frame, isDestroyed: () => false }
    const dispatch = vi.fn().mockResolvedValue({ ok: true, data: {} })
    const handler = createRequestHandler(() => renderer, frame.url, dispatch)
    expect(await handler({ sender: renderer, senderFrame: frame }, request)).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { ModelStore } from '../../apps/desktop/src/main/pet/model-store'
import * as validation from '../../apps/desktop/src/main/pet/model-validation'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}))

let temporary: string, source: string, storeRoot: string
let store: ModelStore
const entry = 'pet.model3.json'
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(type, 4)
    data.copy(result, 8)
    let crc = 0xffffffff
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(5))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
async function imported() {
  const result = await store.importModel(source, entry)
  expect(result.status).toBe('imported')
  if (result.status === 'invalid') throw new Error('unexpected-invalid')
  return result.model
}
beforeEach(async () => {
  temporary = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'bugu-model-store-')),
  )
  source = path.join(temporary, 'source')
  storeRoot = path.join(temporary, 'private-store')
  await fs.mkdir(source)
  await fs.writeFile(
    path.join(source, entry),
    JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] },
    }),
  )
  await fs.writeFile(path.join(source, 'pet.moc3'), 'MOC3\x01\0\0\0')
  await fs.writeFile(path.join(source, 'pet.png'), png())
  store = new ModelStore(storeRoot)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(temporary, { recursive: true, force: true })
})

describe('controlled model store', () => {
  it('copies verified bytes, persists registration and explicit selection across restart', async () => {
    const model = await imported()
    expect(model.id).toMatch(/^[a-f0-9]{64}$/u)
    expect((await store.list()).currentModelId).toBeNull()
    expect(
      await fs.readFile(path.join(storeRoot, model.id, 'pet.png')),
    ).toEqual(png())
    await store.select(model.id)
    const restarted = new ModelStore(storeRoot)
    expect((await restarted.list()).currentModelId).toBe(model.id)
    await fs.rm(source, { recursive: true })
    expect((await restarted.list()).models).toHaveLength(1)
    const mode = (await fs.stat(path.join(storeRoot, model.id, entry))).mode
    if (process.platform !== 'win32') expect(mode & 0o077).toBe(0)
  })
  it('returns stable duplicate IDs without switching current or duplicating bytes', async () => {
    const model = await imported()
    const result = await store.importModel(source, entry)
    expect(result.status).toBe('duplicate')
    if (result.status !== 'invalid') expect(result.model.id).toBe(model.id)
    expect((await store.list()).models).toHaveLength(1)
    expect((await store.list()).currentModelId).toBeNull()
  })
  it('switches and removes models independently; current removal clears selection', async () => {
    const first = await imported()
    await store.select(first.id)
    await fs.writeFile(path.join(source, 'pet.moc3'), 'MOC3\x02\0\0\0')
    const second = await imported()
    expect((await store.list()).currentModelId).toBe(first.id)
    await store.select(second.id)
    await store.remove(first.id)
    expect((await store.list()).currentModelId).toBe(second.id)
    await expect(fs.stat(path.join(storeRoot, first.id))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
    expect((await store.remove(second.id)).currentModelId).toBeNull()
    await expect(store.select('../../bad')).rejects.toMatchObject({
      code: 'unknown-model',
    })
  })
  it('invalid or missing models preserve existing selection', async () => {
    const model = await imported()
    await store.select(model.id)
    await fs.rm(path.join(source, 'pet.png'))
    expect((await store.importModel(source, entry)).status).toBe('invalid')
    expect(
      (await store.importModel(path.join(temporary, 'absent'), entry)).status,
    ).toBe('invalid')
    expect((await store.list()).currentModelId).toBe(model.id)
  })
  it('rejects same-sized source mutations between preflight and copy', async () => {
    const original = validation.validateModelDirectory
    vi.spyOn(validation, 'validateModelDirectory').mockImplementation(
      async (...args) => {
        const result = await original(...args)
        if (args[0] === source)
          await fs.writeFile(path.join(source, 'pet.moc3'), 'MOC3\x03\0\0\0')
        return result
      },
    )
    await expect(store.importModel(source, entry)).rejects.toMatchObject({
      code: 'source-changed',
    })
    expect((await store.list()).models).toHaveLength(0)
    expect(
      (await fs.readdir(storeRoot)).some((name) =>
        name.startsWith('.staging-'),
      ),
    ).toBe(false)
  })
  it('rejects a source symlink introduced after preflight', async ctx => {
    await fs.writeFile(path.join(temporary, 'outside.moc3'), 'MOC3\x01\0\0\0')
    const original = validation.validateModelDirectory
    vi.spyOn(validation, 'validateModelDirectory').mockImplementation(
      async (...args) => {
        const result = await original(...args)
        if (args[0] === source) {
          await fs.rm(path.join(source, 'pet.moc3'))
          try {
            await fs.symlink(
              path.join(temporary, 'outside.moc3'),
              path.join(source, 'pet.moc3'),
            )
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
            throw error
          }
        }
        return result
      },
    )
    await expect(store.importModel(source, entry)).rejects.toMatchObject({
      code: 'source-changed',
    })
    expect((await store.list()).models).toHaveLength(0)
  })
  it('revalidates staging bytes and refuses publication when the copy differs', async () => {
    const original = validation.validateModelDirectory
    vi.spyOn(validation, 'validateModelDirectory').mockImplementation(
      async (...args) => {
        if (path.basename(args[0]).startsWith('.staging-'))
          await fs.writeFile(path.join(args[0], 'pet.moc3'), 'BAD!\x01\0\0\0')
        return original(...args)
      },
    )
    await expect(store.importModel(source, entry)).rejects.toMatchObject({
      code: 'source-changed',
    })
    expect((await store.list()).models).toHaveLength(0)
  })
  it('keeps original current when copying fails midway and removes unfinished staging', async () => {
    const model = await imported()
    await store.select(model.id)
    await fs.writeFile(path.join(source, 'pet.moc3'), 'MOC3\x02\0\0\0')
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (
        String(args[0]).includes('.staging-') &&
        String(args[0]).endsWith('pet.png') &&
        args[1] === 'wx'
      )
        throw new Error('synthetic-disk-full')
      return original(...args)
    })
    await expect(store.importModel(source, entry)).rejects.toThrow(
      'synthetic-disk-full',
    )
    vi.restoreAllMocks()
    expect((await new ModelStore(storeRoot).list()).currentModelId).toBe(
      model.id,
    )
    expect(
      (await fs.readdir(storeRoot)).some((name) =>
        name.startsWith('.staging-'),
      ),
    ).toBe(false)
  })
  it('recovers abandoned staging, registry temps and unregistered publish after interruption', async () => {
    const model = await imported()
    await store.select(model.id)
    const stageName = '.staging-00000000-0000-0000-0000-000000000001'
    const registryName = '.registry-00000000-0000-0000-0000-000000000001'
    await fs.mkdir(path.join(storeRoot, stageName))
    await fs.writeFile(path.join(storeRoot, stageName, 'partial'), 'partial')
    await fs.writeFile(path.join(storeRoot, registryName), '{partial')
    await fs.mkdir(path.join(storeRoot, 'a'.repeat(64)))
    const recovered = await new ModelStore(storeRoot).list()
    expect(recovered.currentModelId).toBe(model.id)
    expect((await fs.readdir(storeRoot)).sort()).toEqual(
      [model.id, 'registry.json'].sort(),
    )
  })
  it('clears a missing or tampered current model on restart', async () => {
    const model = await imported()
    await store.select(model.id)
    await fs.writeFile(
      path.join(storeRoot, model.id, 'pet.moc3'),
      'MOC3\x07\0\0\0',
    )
    const recovered = await new ModelStore(storeRoot).list()
    expect(recovered).toEqual({ currentModelId: null, models: [] })
  })
  it('fails closed on corrupt registry without deleting existing assets', async () => {
    const model = await imported()
    await fs.writeFile(path.join(storeRoot, 'registry.json'), '{broken')
    await expect(new ModelStore(storeRoot).list()).rejects.toMatchObject({
      code: 'invalid-store',
    })
    expect((await fs.stat(path.join(storeRoot, model.id))).isDirectory()).toBe(
      true,
    )
  })
  it('rejects root overlap and a symlink used as controlled storage', async ctx => {
    await expect(
      new ModelStore(path.join(source, 'store')).importModel(source, entry),
    ).rejects.toMatchObject({ code: 'invalid-store' })
    await fs.mkdir(storeRoot, { mode: 0o700 })
    const link = path.join(temporary, 'linked-store')
    try {
      await fs.symlink(storeRoot, link)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw error
    }
    await expect(new ModelStore(link).list()).rejects.toMatchObject({
      code: 'invalid-store',
    })
  })
  it('serializes simultaneous imports from two in-process instances', async () => {
    const results = await Promise.all([
      store.importModel(source, entry),
      new ModelStore(storeRoot).importModel(source, entry),
    ])
    expect(results.map((result) => result.status).sort()).toEqual([
      'duplicate',
      'imported',
    ])
    expect((await store.list()).models).toHaveLength(1)
  })
  it('removes orphan published bytes if registry commit fails', async () => {
    const original = fs.rename
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (String(args[0]).includes('.registry-'))
        throw new Error('synthetic-registry-failure')
      return original(...args)
    })
    await expect(store.importModel(source, entry)).rejects.toThrow(
      'synthetic-registry-failure',
    )
    vi.restoreAllMocks()
    expect((await new ModelStore(storeRoot).list()).models).toHaveLength(0)
    expect(await fs.readdir(storeRoot)).toEqual([])
  })
})

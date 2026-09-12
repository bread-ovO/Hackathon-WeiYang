import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readPluginManifestFile } from '../../packages/plugin-host/src/install'
import { HTTP_JSON_MANIFEST_EXAMPLE, LOCAL_JSONL_MANIFEST_EXAMPLE } from '../../packages/plugin-host/src/manifest'
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof import('node:fs/promises')>() }))
let root: string, file: string
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'bugu-plugin-install-')))
  file = path.join(root, 'plugin.json')
  await fs.writeFile(file, JSON.stringify(HTTP_JSON_MANIFEST_EXAMPLE))
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
describe('selected declarative manifest file reader', () => {
  it.each([HTTP_JSON_MANIFEST_EXAMPLE, LOCAL_JSONL_MANIFEST_EXAMPLE])('reads and validates $kind', async (manifest) => {
    await fs.writeFile(file, JSON.stringify(manifest))
    const result = await readPluginManifestFile(file)
    expect(result.manifest).toEqual(manifest)
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.manifest).not.toBe(manifest)
  })
  it('has stable digests across object key order and formatting, sensitive to values', async () => {
    const first = await readPluginManifestFile(file)
    function reorder(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reorder)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, val]) => [key, reorder(val)]))
      return value
    }
    await fs.writeFile(file, JSON.stringify(reorder(HTTP_JSON_MANIFEST_EXAMPLE), null, 4))
    expect((await readPluginManifestFile(file)).digest).toBe(first.digest)
    await fs.writeFile(file, JSON.stringify({ ...HTTP_JSON_MANIFEST_EXAMPLE, version: '1.0.1' }))
    expect((await readPluginManifestFile(file)).digest).not.toBe(first.digest)
  })
  it.each(['relative.json', '/missing/../plugin.json', '/missing/./plugin.json', 'bad\0name'])('rejects unsafe path %s', async (value) => {
    await expect(readPluginManifestFile(value)).rejects.toMatchObject({ code: 'PLUGIN_FILE_INVALID' })
  })
  it('rejects oversized files before opening', async () => {
    await fs.writeFile(file, Buffer.alloc(128 * 1024 + 1))
    const spy = vi.spyOn(fs, 'open')
    await expect(readPluginManifestFile(file)).rejects.toMatchObject({ code: 'PLUGIN_FILE_LIMIT_EXCEEDED' })
    expect(spy).not.toHaveBeenCalled()
  })
  it.each([Buffer.from([0xff]), Buffer.from('{bad'), Buffer.from('[]'), Buffer.from('{"schemaVersion":99}')])('rejects bad UTF8/JSON/schema %#', async (bytes) => {
    await fs.writeFile(file, bytes)
    await expect(readPluginManifestFile(file)).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
  })
  it('rejects incompatible host versions', async () => {
    await fs.writeFile(file, JSON.stringify({ ...HTTP_JSON_MANIFEST_EXAMPLE, hostApiRange: { minInclusive: '2.0.0', maxExclusive: '3.0.0' } }))
    await expect(readPluginManifestFile(file)).rejects.toMatchObject({ code: 'PLUGIN_MANIFEST_INVALID' })
  })
  it('rejects directories and missing files without leaking paths', async () => {
    for (const value of [root, path.join(root, 'missing')]) {
      await expect(readPluginManifestFile(value)).rejects.toMatchObject({ message: 'PLUGIN_FILE_INVALID' })
    }
  })
  it.skipIf(process.platform === 'win32')('rejects file and parent symlinks', async () => {
    const link = path.join(root, 'link.json'); await fs.symlink(file, link)
    await expect(readPluginManifestFile(link)).rejects.toMatchObject({ code: 'PLUGIN_FILE_INVALID' })
    const parent = path.join(root, 'linked-parent'); await fs.symlink(root, parent)
    await expect(readPluginManifestFile(path.join(parent, 'plugin.json'))).rejects.toMatchObject({ code: 'PLUGIN_FILE_INVALID' })
  })
  it('detects replacement between lstat and descriptor open', async () => {
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      await fs.rename(file, path.join(root, 'old.json'))
      await fs.writeFile(file, JSON.stringify(LOCAL_JSONL_MANIFEST_EXAMPLE))
      return original(...args)
    })
    await expect(readPluginManifestFile(file)).rejects.toMatchObject({ code: 'PLUGIN_FILE_CHANGED' })
  })
  it('detects mutation after the descriptor is opened', async () => {
    const original = fs.lstat
    let seen = 0
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === file && ++seen === 2) await fs.appendFile(file, ' ')
      return original(...args)
    })
    await expect(readPluginManifestFile(file)).rejects.toMatchObject({ code: 'PLUGIN_FILE_CHANGED' })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ExportFileError,
  saveExportFile,
} from '../../apps/desktop/src/main/export-file'
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))
let directory: string, target: string
const old = '{"previous":true}'
beforeEach(async () => {
  directory = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'bugu-export-test-')),
  )
  target = path.join(directory, 'export.json')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})
const noTemps = async () =>
  expect(
    (await fs.readdir(directory)).filter((name) =>
      name.startsWith('.bugu-export-'),
    ),
  ).toEqual([])

describe('native-selected atomic JSON export', () => {
  it('writes exact UTF-8 bytes with private permissions', async () => {
    const contents = '{\n  "note": "虚构测试"\n}\n'
    expect(await saveExportFile(target, contents)).toEqual({
      bytes: Buffer.byteLength(contents),
    })
    expect(await fs.readFile(target, 'utf8')).toBe(contents)
    if (process.platform !== 'win32')
      expect((await fs.stat(target)).mode & 0o077).toBe(0)
    await noTemps()
  })
  it('atomically overwrites an existing regular file', async () => {
    await fs.writeFile(target, old)
    await saveExportFile(target, '{"next":true}')
    expect(await fs.readFile(target, 'utf8')).toBe('{"next":true}')
    await noTemps()
  })
  it('preserves existing output on rename failure and removes its temporary file', async () => {
    await fs.writeFile(target, old)
    vi.spyOn(fs, 'rename').mockRejectedValue(
      new Error(`secret-path: ${directory}`),
    )
    await expect(saveExportFile(target, '{}')).rejects.toMatchObject({
      code: 'EXPORT_WRITE_FAILED',
      message: 'EXPORT_WRITE_FAILED',
    })
    expect(await fs.readFile(target, 'utf8')).toBe(old)
    await noTemps()
  })
  it('preserves existing output on sync failure and closes temporary file', async () => {
    await fs.writeFile(target, old)
    const original = fs.open
    let closed = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await original(...args)
      const close = file.close.bind(file)
      file.sync = async () => {
        throw new Error('synthetic-sync-failure')
      }
      file.close = async () => {
        closed = true
        await close()
      }
      return file
    })
    await expect(saveExportFile(target, '{}')).rejects.toMatchObject({
      code: 'EXPORT_WRITE_FAILED',
    })
    expect(closed).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe(old)
    await noTemps()
  })
  it('rejects target symlinks without changing the link destination', async (context) => {
    const original = path.join(directory, 'original.json')
    await fs.writeFile(original, old)
    try {
      await fs.symlink(original, target)
    } catch (error) {
      if (
        process.platform === 'win32' &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      )
        return context.skip()
      throw error
    }
    await expect(saveExportFile(target, '{}')).rejects.toMatchObject({
      code: 'EXPORT_WRITE_FAILED',
    })
    expect(await fs.readFile(original, 'utf8')).toBe(old)
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
    await noTemps()
  })
  it('rejects a directory target, nonexistent parent, relative path, invalid JSON and NUL', async () => {
    const folder = path.join(directory, 'folder')
    await fs.mkdir(folder)
    for (const selected of [
      folder,
      path.join(directory, 'absent/export.json'),
      'relative.json',
      target + '\0',
    ])
      await expect(saveExportFile(selected, '{}')).rejects.toMatchObject({
        code: 'EXPORT_WRITE_FAILED',
      })
    await expect(saveExportFile(target, '{broken')).rejects.toMatchObject({
      code: 'EXPORT_WRITE_FAILED',
    })
    await noTemps()
  })
  it('enforces 16 MiB by UTF-8 bytes, not character length', async () => {
    await fs.writeFile(target, old)
    await expect(
      saveExportFile(target, JSON.stringify('界'.repeat(6 * 1024 * 1024))),
    ).rejects.toMatchObject({ code: 'EXPORT_LIMIT_EXCEEDED' })
    expect(await fs.readFile(target, 'utf8')).toBe(old)
    await noTemps()
  })
  it('detects target replacement before rename and does not overwrite the new file', async () => {
    await fs.writeFile(target, old)
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await original(...args)
      const sync = file.sync.bind(file)
      file.sync = async () => {
        await sync()
        await fs.rm(target)
        await fs.writeFile(target, '{"external":true}')
      }
      return file
    })
    await expect(saveExportFile(target, '{}')).rejects.toMatchObject({
      code: 'EXPORT_WRITE_FAILED',
    })
    expect(await fs.readFile(target, 'utf8')).toBe('{"external":true}')
    await noTemps()
  })
  it('refuses a newly-created target that was absent at selection time', async () => {
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await original(...args)
      await fs.writeFile(target, old)
      return file
    })
    await expect(saveExportFile(target, '{}')).rejects.toMatchObject({
      code: 'EXPORT_WRITE_FAILED',
    })
    expect(await fs.readFile(target, 'utf8')).toBe(old)
    await noTemps()
  })
  it('detects a changed parent identity before publication and cleans the temp', async () => {
    await fs.writeFile(target, old)
    const original = fs.lstat
    let parentReads = 0
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const stat = await original(...args)
      if (String(args[0]) === directory && ++parentReads > 1) {
        Object.defineProperty(stat, 'ino', { value: Number(stat.ino) + 1 })
      }
      return stat
    })
    await expect(saveExportFile(target, '{}')).rejects.toMatchObject({
      code: 'EXPORT_WRITE_FAILED',
    })
    expect(await fs.readFile(target, 'utf8')).toBe(old)
    await noTemps()
  })
  it('does not leak filesystem errors or destination paths', async () => {
    try {
      await saveExportFile(path.join(directory, 'absent/export.json'), '{}')
    } catch (error) {
      expect(error).toBeInstanceOf(ExportFileError)
      expect((error as Error).message).toBe('EXPORT_WRITE_FAILED')
      expect(JSON.stringify(error)).not.toContain(directory)
    }
  })
})

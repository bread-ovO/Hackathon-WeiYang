import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readCredentialFile } from '../../apps/desktop/src/main/credential-input'
import { symlinkOrSkip } from './helpers/symlink-or-skip'
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))
let folder: string, file: string
beforeEach(async () => {
  folder = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'bugu-credential-input-')),
  )
  file = join(folder, 'synthetic-token.txt')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(folder, { recursive: true, force: true })
})
describe('host selected credential token file', () => {
  it.each(['', '\n', '\r\n'])(
    'reads a token with optional one trailing newline %j and leaves the source unchanged',
    async (newline) => {
      const original = `SYNTHETIC.Token_123-~+/==${newline}`
      await fs.writeFile(file, original)
      expect(await readCredentialFile(file)).toBe('SYNTHETIC.Token_123-~+/==')
      expect(await fs.readFile(file, 'utf8')).toBe(original)
    },
  )
  it.each([
    '',
    '\n',
    '\r\n',
    'token\r',
    ' token',
    'token ',
    'token\n\n',
    'token\r\n\r\n',
    'to\nken',
    'to\tken',
    '\uFEFFtoken',
    'token\u00a0',
    'token\0',
    '中token',
    'token:other',
    'token=middle',
  ])('rejects malformed token %j with a fixed error', async (token) => {
    await fs.writeFile(file, token)
    await expect(readCredentialFile(file)).rejects.toEqual(
      new Error('VAULT_INVALID_DATA'),
    )
  })
  it('checks file bytes including the trailing newline', async () => {
    await fs.writeFile(file, 'a'.repeat(8192))
    expect((await readCredentialFile(file)).length).toBe(8192)
    await fs.writeFile(file, 'a'.repeat(8191) + '\n')
    expect((await readCredentialFile(file)).length).toBe(8191)
    await fs.writeFile(file, 'a'.repeat(8192) + '\n')
    await expect(readCredentialFile(file)).rejects.toThrow('VAULT_INVALID_DATA')
  })
  it('rejects malformed UTF-8 without disclosing content', async () => {
    await fs.writeFile(file, Buffer.from([0x61, 0xc0, 0xaf]))
    await expect(readCredentialFile(file)).rejects.toEqual(
      new Error('VAULT_INVALID_DATA'),
    )
  })
  it('rejects relative paths, missing files, directories and symlinks', async (ctx) => {
    await fs.writeFile(file, 'SYNTHETIC')
    const link = join(folder, 'link.txt')
    await symlinkOrSkip(ctx, file, link)
    for (const path of ['relative.txt', join(folder, 'missing'), folder, link])
      await expect(readCredentialFile(path)).rejects.toEqual(
        new Error('VAULT_INVALID_DATA'),
      )
  })
  it('rejects replacement between path inspection and opening', async () => {
    await fs.writeFile(file, 'FIRST')
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      await fs.rename(file, join(folder, 'old.txt'))
      await fs.writeFile(file, 'SECOND')
      return original(...args)
    })
    await expect(readCredentialFile(file)).rejects.toEqual(
      new Error('VAULT_INVALID_DATA'),
    )
  })
  it('rejects in-place changes during read and closes the descriptor', async () => {
    await fs.writeFile(file, 'FIRST')
    const original = fs.open
    let closed = false
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await original(...args)
      const read = handle.read.bind(handle),
        close = handle.close.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(
        async (...readArgs: Parameters<typeof read>) => {
          await fs.writeFile(file, 'CHANGED')
          return read(...readArgs)
        },
      )
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        closed = true
        await close()
      })
      return handle
    })
    await expect(readCredentialFile(file)).rejects.toEqual(
      new Error('VAULT_INVALID_DATA'),
    )
    expect(closed).toBe(true)
  })
  it('rejects a path replaced after fd read even when the opened inode is unchanged', async () => {
    await fs.writeFile(file, 'FIRST')
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await original(...args)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementationOnce(
        async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs)
          await fs.rename(file, join(folder, 'original.txt'))
          await fs.writeFile(file, 'SECOND')
          return result
        },
      )
      return handle
    })
    await expect(readCredentialFile(file)).rejects.toEqual(
      new Error('VAULT_INVALID_DATA'),
    )
  })
  it('normalizes native filesystem failures without path or secret text', async () => {
    await fs.writeFile(file, 'SYNTHETIC_SECRET')
    vi.spyOn(fs, 'open').mockRejectedValueOnce(
      new Error(`${file}: SYNTHETIC_SECRET native detail`),
    )
    await expect(readCredentialFile(file)).rejects.toEqual(
      new Error('VAULT_INVALID_DATA'),
    )
  })
})

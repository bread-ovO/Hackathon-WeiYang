import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  createCredentialVault,
  CredentialVaultError,
  type CryptoAdapter,
} from '../../apps/desktop/src/main/credential-vault'
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))
let root: string
let crypto: CryptoAdapter
const metadata = {
  label: 'Fictional key',
  domain: 'api.example.com',
  purpose: 'source' as const,
}
const secret = 'fictional-test-secret'
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'bugu-vault-')))
  const key = randomBytes(32)
  crypto = {
    isAvailable: () => true,
    encrypt: (text) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([
        iv,
        cipher.update(text, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ])
    },
    decrypt: (bytes) => {
      const data = Buffer.from(bytes)
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      cipher.setAuthTag(data.subarray(-16))
      return Buffer.concat([
        cipher.update(data.subarray(12, -16)),
        cipher.final(),
      ]).toString('utf8')
    },
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
const file = () => path.join(root, 'credentials.json')
async function mutate(fn: (value: any) => void) {
  const value = JSON.parse(await fs.readFile(file(), 'utf8'))
  fn(value)
  await fs.writeFile(file(), JSON.stringify(value))
}
describe('private encrypted credential vault', () => {
  it('snapshots queued metadata and read scope before asynchronous work', async () => {
    const vault = createCredentialVault(root, crypto)
    const mutable = { ...metadata }
    const pending = vault.import(mutable, secret)
    mutable.domain = 'changed.example.com'
    mutable.label = 'changed'
    const item = await pending
    expect(item.domain).toBe(metadata.domain)
    const scope = { domain: metadata.domain, purpose: metadata.purpose }
    const reading = vault.read(item.id, scope)
    scope.domain = 'changed.example.com'
    expect(await reading).toBe(secret)
  })
  it('copies encrypted bytes before an awaited backend check can reuse them', async () => {
    const encrypt = crypto.encrypt
    let encrypted: Uint8Array | undefined
    crypto.encrypt = async (text) => { encrypted = await encrypt(text); return encrypted }
    crypto.isAvailable = async () => { encrypted?.fill(0); return true }
    const vault = createCredentialVault(root, crypto)
    const item = await vault.import(metadata, secret)
    expect(await vault.read(item.id, metadata)).toBe(secret)
  })
  it('rejects same-size staging modification before atomic publish', async () => {
    const vault = createCredentialVault(root, crypto)
    await vault.import(metadata, secret)
    const previous = await fs.readFile(file())
    const original = fs.lstat
    let changed = false
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const name = String(args[0])
      if (!changed && name.endsWith('.tmp')) {
        changed = true
        const bytes = await fs.readFile(name)
        bytes[0] = 32
        await fs.writeFile(name, bytes)
        await fs.utimes(name, new Date(0), new Date(0))
      }
      return original(...args)
    })
    await expect(vault.import(metadata, 'second')).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' })
    expect(await fs.readFile(file())).toEqual(previous)
    expect(await fs.readdir(root)).toEqual(['credentials.json'])
  })
  it('sanitizes even typed adapter errors and backend availability exceptions', async () => {
    const vault = createCredentialVault(root, crypto)
    const error = new CredentialVaultError('VAULT_WRITE_FAILED')
    error.message = secret
    crypto.encrypt = () => { throw error }
    await expect(vault.import(metadata, secret)).rejects.toMatchObject({ message: 'VAULT_WRITE_FAILED' })
    crypto.isAvailable = () => { throw new Error(secret) }
    await expect(vault.import(metadata, secret)).rejects.toMatchObject({ message: 'VAULT_UNAVAILABLE' })
  })

  it('roundtrips encrypted credentials after reopening, exposing only metadata', async () => {
    const vault = createCredentialVault(root, crypto)
    const item = await vault.import(metadata, secret)
    expect(await vault.list()).toEqual([item])
    expect(Object.keys(item).sort()).toEqual([
      'createdAt',
      'domain',
      'id',
      'label',
      'purpose',
    ])
    expect(await fs.readFile(file(), 'utf8')).not.toContain(secret)
    expect(
      await createCredentialVault(root, crypto).read(item.id, metadata),
    ).toBe(secret)
    if (process.platform !== 'win32')
      expect((await fs.stat(file())).mode & 0o777).toBe(0o600)
  })
  it('serializes concurrent changes and persists deletion', async () => {
    const vault = createCredentialVault(root, crypto)
    const items = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        vault.import({ ...metadata, label: `Key ${i}` }, secret),
      ),
    )
    expect(await vault.list()).toHaveLength(8)
    await Promise.all(items.slice(0, 4).map((item) => vault.remove(item.id)))
    expect(await createCredentialVault(root, crypto).list()).toHaveLength(4)
    await expect(vault.read(items[0]!.id, metadata)).rejects.toMatchObject({
      code: 'VAULT_NOT_FOUND',
    })
  })
  it('allows listing and removal without crypto but never reads/writes secrets', async () => {
    const vault = createCredentialVault(root, crypto)
    const item = await vault.import(metadata, secret)
    crypto.isAvailable = () => false
    expect(await vault.list()).toEqual([item])
    await expect(vault.read(item.id, metadata)).rejects.toMatchObject({
      code: 'VAULT_UNAVAILABLE',
    })
    await expect(vault.import(metadata, secret)).rejects.toMatchObject({
      code: 'VAULT_UNAVAILABLE',
    })
    await vault.remove(item.id)
    expect(await vault.list()).toEqual([])
  })
  it.each(['', ' ', 'x\r\ny', 'x\0y', 'x'.repeat(8193), '界'.repeat(2731)])(
    'rejects invalid secret %#',
    async (value) => {
      await expect(
        createCredentialVault(root, crypto).import(metadata, value),
      ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID_INPUT' })
      expect(await fs.readdir(root)).toEqual([])
    },
  )
  it.each([
    { label: '' },
    { domain: '*.example.com' },
    { domain: 'https://api.example.com' },
    { purpose: 'other' },
  ])('rejects malformed metadata %j', async (value) => {
    await expect(
      createCredentialVault(root, crypto).import(
        { ...metadata, ...value } as typeof metadata,
        secret,
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID_INPUT' })
  })
  it('rejects scope mismatch before decrypting', async () => {
    const vault = createCredentialVault(root, crypto)
    const item = await vault.import(metadata, secret)
    const decrypt = vi.spyOn(crypto, 'decrypt')
    await expect(
      vault.read(item.id, { ...metadata, domain: 'other.example.com' }),
    ).rejects.toMatchObject({ code: 'VAULT_SCOPE_MISMATCH' })
    await expect(
      vault.read(item.id, { ...metadata, purpose: 'model' }),
    ).rejects.toMatchObject({ code: 'VAULT_SCOPE_MISMATCH' })
    expect(decrypt).not.toHaveBeenCalled()
  })
  it.each(['domain', 'purpose', 'label', 'id'])(
    'binds ciphertext to metadata %s',
    async (key) => {
      const vault = createCredentialVault(root, crypto)
      await vault.import(metadata, secret)
      await mutate((data) => {
        data.records[0][key] = (
          {
            domain: 'other.example.com',
            purpose: 'model',
            label: 'Changed',
            id: '11111111-1111-4111-8111-111111111111',
          } as Record<string, string>
        )[key]
      })
      const item = (await vault.list())[0]!
      await expect(vault.read(item.id, item)).rejects.toMatchObject({
        code: 'VAULT_INVALID_DATA',
      })
    },
  )
  it('rejects exchanged encrypted payloads', async () => {
    const vault = createCredentialVault(root, crypto)
    const first = await vault.import(metadata, secret)
    await vault.import(metadata, 'other-secret')
    await mutate((data) => {
      data.records[0].ciphertext = data.records[1].ciphertext
    })
    await expect(vault.read(first.id, metadata)).rejects.toMatchObject({
      code: 'VAULT_INVALID_DATA',
    })
  })
  it.each([
    Buffer.from('{broken'),
    Buffer.from([0xff]),
    Buffer.from('{"version":2,"records":[]}'),
  ])('fails closed on corrupt file %# without reset', async (bytes) => {
    await fs.writeFile(file(), bytes)
    const vault = createCredentialVault(root, crypto)
    await expect(vault.list()).rejects.toMatchObject({
      code: 'VAULT_INVALID_DATA',
    })
    await expect(vault.import(metadata, secret)).rejects.toMatchObject({
      code: 'VAULT_INVALID_DATA',
    })
    expect(await fs.readFile(file())).toEqual(bytes)
  })
  it('rejects oversized storage before reading it', async () => {
    await fs.writeFile(file(), Buffer.alloc(2 * 1024 * 1024 + 1))
    await expect(
      createCredentialVault(root, crypto).list(),
    ).rejects.toMatchObject({ code: 'VAULT_INVALID_DATA' })
  })
  it('rejects target and root symlinks', async () => {
    if (process.platform === 'win32') return
    const actual = path.join(root, 'actual')
    await fs.writeFile(actual, 'unchanged')
    await fs.symlink(actual, file())
    await expect(
      createCredentialVault(root, crypto).list(),
    ).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' })
    expect(await fs.readFile(actual, 'utf8')).toBe('unchanged')
    const link = path.join(root, 'link')
    await fs.symlink(root, link)
    await expect(
      createCredentialVault(link, crypto).list(),
    ).rejects.toMatchObject({ code: 'VAULT_WRITE_FAILED' })
  })
  it('preserves existing ciphertext on publish failure, cleans temporary file, sanitizes errors', async () => {
    const vault = createCredentialVault(root, crypto)
    await vault.import(metadata, secret)
    const previous = await fs.readFile(file())
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error(`${root} ${secret}`))
    await expect(vault.import(metadata, 'second')).rejects.toMatchObject({
      code: 'VAULT_WRITE_FAILED',
      message: 'VAULT_WRITE_FAILED',
    })
    expect(await fs.readFile(file())).toEqual(previous)
    expect(await fs.readdir(root)).toEqual(['credentials.json'])
    expect(await vault.list()).toHaveLength(1)
  })
  it('ignores abandoned staging and rejects plaintext fields', async () => {
    await fs.writeFile(
      path.join(root, '.credentials-abandoned.tmp'),
      'fictional incomplete ciphertext',
    )
    const vault = createCredentialVault(root, crypto)
    expect(await vault.list()).toEqual([])
    await vault.import(metadata, secret)
    await mutate((data) => {
      data.records[0].secret = 'unexpected'
    })
    await expect(vault.list()).rejects.toMatchObject({
      code: 'VAULT_INVALID_DATA',
    })
  })
  it('rejects the 129th import without modifying a full registry', async () => {
    const vault = createCredentialVault(root, crypto)
    await vault.import(metadata, secret)
    await mutate((data) => {
      data.records = Array.from({ length: 128 }, () => ({
        ...data.records[0],
        id: randomUUID(),
      }))
    })
    const previous = await fs.readFile(file())
    await expect(vault.import(metadata, secret)).rejects.toMatchObject({
      code: 'VAULT_INVALID_DATA',
    })
    expect(await fs.readFile(file())).toEqual(previous)
  })
  it('rejects registry replacement during encryption and preserves the replacement', async () => {
    const vault = createCredentialVault(root, crypto)
    await vault.import(metadata, secret)
    const encrypt = crypto.encrypt
    crypto.encrypt = async (text) => {
      await fs.writeFile(file(), '{external replacement}')
      return encrypt(text)
    }
    await expect(vault.import(metadata, 'second')).rejects.toMatchObject({
      code: 'VAULT_WRITE_FAILED',
    })
    expect(await fs.readFile(file(), 'utf8')).toBe('{external replacement}')
    expect(await fs.readdir(root)).toEqual(['credentials.json'])
  })
  it('preserves storage when encryption throws or availability disappears', async () => {
    const vault = createCredentialVault(root, crypto)
    await vault.import(metadata, secret)
    const previous = await fs.readFile(file())
    const encrypt = crypto.encrypt
    crypto.encrypt = () => {
      throw new Error(secret)
    }
    await expect(vault.import(metadata, 'second')).rejects.toMatchObject({
      message: 'VAULT_WRITE_FAILED',
    })
    crypto.encrypt = async (text) => {
      crypto.isAvailable = () => false
      return encrypt(text)
    }
    await expect(vault.import(metadata, 'second')).rejects.toMatchObject({
      code: 'VAULT_UNAVAILABLE',
    })
    expect(await fs.readFile(file())).toEqual(previous)
  })
  it('rejects record count overflow', async () => {
    const vault = createCredentialVault(root, crypto)
    await vault.import(metadata, secret)
    await mutate((data) => {
      data.records = Array(129).fill(data.records[0])
    })
    await expect(vault.list()).rejects.toMatchObject({
      code: 'VAULT_INVALID_DATA',
    })
  })
})

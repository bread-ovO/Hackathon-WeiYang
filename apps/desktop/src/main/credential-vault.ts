import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { isIP } from 'node:net'

export interface CryptoAdapter {
  isAvailable(): boolean | Promise<boolean>
  encrypt(plaintext: string): Uint8Array | Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): string | Promise<string>
}
export interface CredentialSummary {
  id: string
  label: string
  domain: string
  purpose: 'source' | 'model'
  createdAt: string
}
export type CredentialVaultErrorCode =
  | 'CREDENTIAL_INVALID_INPUT'
  | 'VAULT_UNAVAILABLE'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_SCOPE_MISMATCH'
  | 'VAULT_INVALID_DATA'
  | 'VAULT_WRITE_FAILED'
export class CredentialVaultError extends Error {
  constructor(readonly code: CredentialVaultErrorCode) {
    super(code)
    this.name = 'CredentialVaultError'
  }
}
interface RecordData extends CredentialSummary {
  ciphertext: string
}
const MAX_BYTES = 2 * 1024 * 1024
const MAX_RECORDS = 128
function fail(code: CredentialVaultErrorCode): never {
  throw new CredentialVaultError(code)
}
const exactKeys = (
  value: unknown,
  keys: string[],
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
const validDomain = (domain: unknown): domain is string =>
  typeof domain === 'string' &&
  isIP(domain) === 0 &&
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
    domain,
  )
const validPurpose = (purpose: unknown) =>
  purpose === 'source' || purpose === 'model'
const validLabel = (label: unknown) =>
  typeof label === 'string' &&
  label.trim() === label &&
  label.length > 0 &&
  label.length <= 80 &&
  !/[\x00-\x1f\x7f]/.test(label)
const validSecret = (secret: unknown): secret is string =>
  typeof secret === 'string' &&
  secret.trim().length > 0 &&
  Buffer.byteLength(secret, 'utf8') <= 8192 &&
  !/[\r\n\0]/.test(secret)
const summary = ({
  id,
  label,
  domain,
  purpose,
  createdAt,
}: CredentialSummary): CredentialSummary => ({
  id,
  label,
  domain,
  purpose,
  createdAt,
})
type Identity = Awaited<ReturnType<typeof lstat>>
const same = (a: Identity, b: Identity) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'

/** One owning process per vault. Atomic rename is the commit point; failed writes
 * preserve the old file. No plaintext fallback or secrets in summaries/errors.
 * Ancestor/descriptor checks detect ordinary replacement, not a complete sandbox
 * against a malicious same-user process racing portable Node path operations.
 * Abandoned private temporary files are ignored; they never become the registry.
 */
export function createCredentialVault(root: string, crypto: CryptoAdapter) {
  const rootPath = root
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation).catch((error: unknown) => {
      if (error instanceof CredentialVaultError) {
        // Never forward mutable adapter error messages or causes.
        const codes: readonly string[] = [
          'CREDENTIAL_INVALID_INPUT', 'VAULT_UNAVAILABLE', 'VAULT_NOT_FOUND',
          'VAULT_SCOPE_MISMATCH', 'VAULT_INVALID_DATA', 'VAULT_WRITE_FAILED',
        ]
        throw new CredentialVaultError(
          codes.includes(error.code) ? error.code : 'VAULT_WRITE_FAILED',
        )
      }
      throw new CredentialVaultError('VAULT_WRITE_FAILED')
    })
    queue = result.catch(() => undefined)
    return result
  }
  async function checkRoot(create = false) {
    if (
      typeof rootPath !== 'string' ||
      !path.isAbsolute(rootPath) ||
      rootPath.includes('\0') ||
      rootPath.split(path.sep).some((part) => part === '.' || part === '..')
    )
      fail('CREDENTIAL_INVALID_INPUT')
    const target = path.resolve(rootPath)
    let current = path.parse(target).root
    const identities: { name: string; dev: number; ino: number }[] = []
    for (const part of [
      '',
      ...target.slice(current.length).split(path.sep).filter(Boolean),
    ]) {
      if (part) current = path.join(current, part)
      let stat: Identity
      try {
        stat = await lstat(current)
      } catch (error) {
        if (!create || !missing(error)) throw error
        try {
          await mkdir(current, { mode: 0o700 })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        }
        stat = await lstat(current)
      }
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await realpath(current)) !== current
      )
        fail('VAULT_WRITE_FAILED')
      identities.push({ name: current, dev: stat.dev, ino: stat.ino })
    }
    return { target: path.join(target, 'credentials.json'), identities }
  }
  async function verifyParents(
    identities: { name: string; dev: number; ino: number }[],
  ) {
    for (const item of identities) {
      const stat = await lstat(item.name)
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== item.dev ||
        stat.ino !== item.ino ||
        (await realpath(item.name)) !== item.name
      )
        fail('VAULT_WRITE_FAILED')
    }
  }
  async function load() {
    const location = await checkRoot(true)
    let identity: Identity
    try {
      identity = await lstat(location.target)
    } catch (error) {
      if (missing(error))
        return { ...location, identity: undefined, records: [] as RecordData[] }
      throw error
    }
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1)
      fail('VAULT_WRITE_FAILED')
    if (identity.size > MAX_BYTES) fail('VAULT_INVALID_DATA')
    const file = await open(
      location.target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    let text: string
    try {
      const initial = await file.stat()
      if (!same(identity, initial)) fail('VAULT_WRITE_FAILED')
      const data = Buffer.alloc(identity.size + 1)
      let offset = 0
      while (offset < data.length) {
        const { bytesRead } = await file.read(
          data,
          offset,
          data.length - offset,
          offset,
        )
        if (!bytesRead) break
        offset += bytesRead
      }
      if (
        offset !== identity.size ||
        !same(initial, await file.stat()) ||
        !same(initial, await lstat(location.target))
      )
        fail('VAULT_WRITE_FAILED')
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          data.subarray(0, offset),
        )
      } catch {
        fail('VAULT_INVALID_DATA')
      }
    } finally {
      await file.close()
    }
    await verifyParents(location.identities)
    let parsed: unknown
    try {
      parsed = JSON.parse(text!)
    } catch {
      fail('VAULT_INVALID_DATA')
    }
    if (
      !exactKeys(parsed, ['version', 'records']) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.records)
    )
      fail('VAULT_INVALID_DATA')
    if (parsed.records.length > MAX_RECORDS) fail('VAULT_INVALID_DATA')
    const ids = new Set<string>()
    for (const item of parsed.records) {
      if (
        !exactKeys(item, [
          'id',
          'label',
          'domain',
          'purpose',
          'createdAt',
          'ciphertext',
        ]) ||
        typeof item.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          item.id,
        ) ||
        ids.has(item.id) ||
        !validLabel(item.label) ||
        !validDomain(item.domain) ||
        !validPurpose(item.purpose) ||
        typeof item.createdAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(item.createdAt) ||
        !Number.isFinite(Date.parse(item.createdAt)) ||
        typeof item.ciphertext !== 'string' ||
        item.ciphertext.length === 0 ||
        item.ciphertext.length > 65536 ||
        Buffer.from(item.ciphertext, 'base64').toString('base64') !==
          item.ciphertext
      )
        fail('VAULT_INVALID_DATA')
      ids.add(item.id)
    }
    return { ...location, identity, records: parsed.records as RecordData[] }
  }
  async function available() {
    try {
      if (!(await crypto.isAvailable())) fail('VAULT_UNAVAILABLE')
    } catch {
      fail('VAULT_UNAVAILABLE')
    }
  }
  async function persist(
    state: Awaited<ReturnType<typeof load>>,
    records: RecordData[],
  ) {
    const text = JSON.stringify({ version: 1, records })
    if (Buffer.byteLength(text) > MAX_BYTES) fail('VAULT_INVALID_DATA')
    let temporary: string | undefined = path.join(
      path.dirname(state.target),
      `.credentials-${randomUUID()}.tmp`,
    )
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
      const identity = await file.stat()
      await file.writeFile(text, 'utf8')
      await file.sync()
      const writtenIdentity = await file.stat()
      await file.close()
      file = undefined
      await verifyParents(state.identities)
      const tempStat = await lstat(temporary)
      if (
        !tempStat.isFile() ||
        tempStat.isSymbolicLink() ||
        tempStat.nlink !== 1 ||
        tempStat.dev !== identity.dev ||
        tempStat.ino !== identity.ino ||
        tempStat.size !== Buffer.byteLength(text) ||
        !same(writtenIdentity, tempStat)
      )
        fail('VAULT_WRITE_FAILED')
      let current: Identity | undefined
      try {
        current = await lstat(state.target)
      } catch (error) {
        if (!missing(error)) throw error
      }
      if (
        state.identity
          ? !current || !same(state.identity, current)
          : current !== undefined
      )
        fail('VAULT_WRITE_FAILED')
      await rename(temporary, state.target)
      temporary = undefined
    } finally {
      await file?.close().catch(() => undefined)
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
  return {
    list: () => serial(async () => (await load()).records.map(summary)),
    import(
      metadata: Pick<CredentialSummary, 'label' | 'domain' | 'purpose'>,
      secret: string,
    ) {
      const value = {
        label: metadata?.label,
        domain: metadata?.domain,
        purpose: metadata?.purpose,
      }
      return serial(async () => {
        if (
          !validLabel(value.label) ||
          !validDomain(value.domain) ||
          !validPurpose(value.purpose) ||
          !validSecret(secret)
        )
          fail('CREDENTIAL_INVALID_INPUT')
        await available()
        const state = await load()
        if (state.records.length >= MAX_RECORDS) fail('VAULT_INVALID_DATA')
        const item: CredentialSummary = {
          ...value,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        }
        const encrypted = await crypto.encrypt(
          JSON.stringify({ version: 1, ...item, secret }),
        )
        if (
          !(encrypted instanceof Uint8Array) ||
          encrypted.length === 0 ||
          encrypted.length > 49152
        )
          fail('VAULT_INVALID_DATA')
        // Adapter buffers may be reused after the next await. Freeze the exact
        // validated ciphertext before checking backend availability again.
        const ciphertext = Buffer.from(encrypted).toString('base64')
        await available()
        await persist(state, [
          ...state.records,
          { ...item, ciphertext },
        ])
        return summary(item)
      })
    },
    read(id: string, scope: Pick<CredentialSummary, 'domain' | 'purpose'>) {
      const wanted = { domain: scope?.domain, purpose: scope?.purpose }
      return serial(async () => {
        if (!validDomain(wanted.domain) || !validPurpose(wanted.purpose))
          fail('CREDENTIAL_INVALID_INPUT')
        await available()
        const record = (await load()).records.find((item) => item.id === id)
        if (!record) return fail('VAULT_NOT_FOUND')
        if (
          record.domain !== wanted.domain ||
          record.purpose !== wanted.purpose
        )
          fail('VAULT_SCOPE_MISMATCH')
        let payload: unknown
        try {
          payload = JSON.parse(
            await crypto.decrypt(Buffer.from(record.ciphertext, 'base64')),
          )
        } catch {
          fail('VAULT_INVALID_DATA')
        }
        if (
          !exactKeys(payload, [
            'version',
            'id',
            'label',
            'domain',
            'purpose',
            'createdAt',
            'secret',
          ]) ||
          payload.version !== 1 ||
          Object.entries(summary(record)).some(
            ([key, value]) => payload[key] !== value,
          ) ||
          !validSecret(payload.secret)
        )
          fail('VAULT_INVALID_DATA')
        await available()
        return payload.secret as string
      })
    },
    remove: (id: string) =>
      serial(async () => {
        const state = await load()
        if (!state.records.some((record) => record.id === id))
          fail('VAULT_NOT_FOUND')
        await persist(
          state,
          state.records.filter((record) => record.id !== id),
        )
      }),
  }
}

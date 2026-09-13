import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const MAX_CREDENTIAL_FILE_BYTES = 8192
/** Host-only: path must come from the native credential-file picker, never renderer IPC. */
export async function readCredentialFile(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let buffer: Buffer | undefined
  try {
    if (
      typeof path !== 'string' ||
      !isAbsolute(path) ||
      path.length > 4096 ||
      path.includes('\0')
    )
      throw new Error()
    const before = await lstat(path, { bigint: true })
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(MAX_CREDENTIAL_FILE_BYTES)
    )
      throw new Error()
    const selected = await realpath(path)
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const opened = await handle.stat({ bigint: true })
    const same = (a: typeof before, b: typeof before) =>
      a.ino === b.ino &&
      a.dev === b.dev &&
      a.size === b.size &&
      a.mtimeNs === b.mtimeNs &&
      a.ctimeNs === b.ctimeNs
    const current = await lstat(path, { bigint: true })
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      !same(before, opened) ||
      !same(opened, current) ||
      (await realpath(path)) !== selected
    )
      throw new Error()
    // Read one byte past the permitted size to detect growth, never allocate from file metadata.
    buffer = Buffer.alloc(MAX_CREDENTIAL_FILE_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const result = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        bytes,
      )
      if (!result.bytesRead) break
      bytes += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const finalPath = await lstat(path, { bigint: true })
    if (
      bytes !== Number(opened.size) ||
      bytes > MAX_CREDENTIAL_FILE_BYTES ||
      finalPath.isSymbolicLink() ||
      !same(opened, after) ||
      !same(after, finalPath) ||
      (await realpath(path)) !== selected
    )
      throw new Error()
    // ignoreBOM preserves U+FEFF, so the token grammar rejects it instead of silently stripping it.
    const decoded = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer.subarray(0, bytes))
    const token = decoded.replace(/(?:\r\n|\n)$/, '')
    if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new Error()
    await handle.close()
    handle = undefined
    return token
  } catch {
    throw new Error('VAULT_INVALID_DATA')
  } finally {
    buffer?.fill(0)
    // Cleanup must not leak filesystem messages or replace the fixed public error.
    await handle?.close().catch(() => {})
  }
}

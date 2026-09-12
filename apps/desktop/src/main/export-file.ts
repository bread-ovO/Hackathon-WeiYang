import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export class ExportFileError extends Error {
  constructor(readonly code: 'EXPORT_WRITE_FAILED' | 'EXPORT_LIMIT_EXCEEDED') {
    super(code)
    this.name = 'ExportFileError'
  }
}
const MAX_EXPORT_BYTES = 16 * 1024 * 1024
const failed = () => new ExportFileError('EXPORT_WRITE_FAILED')
type FileIdentity = Awaited<ReturnType<typeof lstat>>
const sameIdentity = (a: FileIdentity, b: FileIdentity) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs

/** Save only to the exact absolute path selected by a trusted native save dialog.
 * Uses a private same-directory temporary file and atomic replacement. Existing content
 * survives all failures before rename. A successful rename is the commit point.
 * Descriptor/path identity checks detect replacements; Node has no portable directory-fd
 * rename API, so this is not a sandbox against a malicious same-user ancestor-swap race.
 */
export async function saveExportFile(
  destination: string,
  contents: string,
): Promise<{ bytes: number }> {
  if (typeof contents !== 'string') throw failed()
  const byteCount = Buffer.byteLength(contents, 'utf8')
  if (byteCount > MAX_EXPORT_BYTES)
    throw new ExportFileError('EXPORT_LIMIT_EXCEEDED')
  if (
    typeof destination !== 'string' ||
    !path.isAbsolute(destination) ||
    destination.includes('\0') ||
    destination.split(path.sep).some((part) => part === '..' || part === '.')
  )
    throw failed()
  // The caller supplies JSON serialization; validating here prevents accidentally saving
  // unrelated text while retaining its exact formatting and UTF-8 bytes.
  try {
    JSON.parse(contents)
  } catch {
    throw failed()
  }
  let temporary: string | undefined
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const target = path.resolve(destination)
    const parent = path.dirname(target)
    const parents: { path: string; dev: number; ino: number }[] = []
    let current = path.parse(parent).root
    for (const part of [
      '',
      ...parent.slice(current.length).split(path.sep).filter(Boolean),
    ]) {
      if (part) current = path.join(current, part)
      const stat = await lstat(current)
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (await realpath(current)) !== current
      )
        throw failed()
      parents.push({ path: current, dev: stat.dev, ino: stat.ino })
    }
    let previous: FileIdentity | undefined
    try {
      previous = await lstat(target)
      if (previous.isSymbolicLink() || !previous.isFile()) throw failed()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    temporary = path.join(parent, `.bugu-export-${randomUUID()}.tmp`)
    file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    const temporaryIdentity = await file.stat()
    await file.writeFile(contents, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    for (const item of parents) {
      const stat = await lstat(item.path)
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.dev !== item.dev ||
        stat.ino !== item.ino ||
        (await realpath(item.path)) !== item.path
      )
        throw failed()
    }
    const temporaryStat = await lstat(temporary)
    if (
      !temporaryStat.isFile() ||
      temporaryStat.isSymbolicLink() ||
      temporaryStat.dev !== temporaryIdentity.dev ||
      temporaryStat.ino !== temporaryIdentity.ino ||
      temporaryStat.size !== byteCount
    )
      throw failed()
    let now: FileIdentity | undefined
    try {
      now = await lstat(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (
      previous
        ? !now ||
          !now.isFile() ||
          now.isSymbolicLink() ||
          !sameIdentity(previous, now)
        : now !== undefined
    )
      throw failed()
    await rename(temporary, target)
    temporary = undefined
    // Do not report a post-commit failure as if the old file had survived.
    return { bytes: byteCount }
  } catch {
    throw failed()
  } finally {
    await file?.close().catch(() => undefined)
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

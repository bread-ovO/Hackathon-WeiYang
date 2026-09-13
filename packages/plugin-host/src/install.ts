import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { parseSourceManifest, type SourceManifest } from './manifest'

export type PluginInstallErrorCode = 'PLUGIN_FILE_INVALID' | 'PLUGIN_FILE_LIMIT_EXCEEDED' |
  'PLUGIN_FILE_CHANGED' | 'PLUGIN_MANIFEST_INVALID'
export class PluginInstallError extends Error {
  constructor(readonly code: PluginInstallErrorCode) { super(code); this.name = 'PluginInstallError' }
}
const MAX_BYTES = 128 * 1024
function fail(code: PluginInstallErrorCode): never { throw new PluginInstallError(code) }
type Identity = Awaited<ReturnType<typeof lstat>>
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}

/** Read only the one file selected by the trusted native picker. No directory
 * discovery, archives, code loading, or registration. Descriptor and ancestor
 * checks detect replacement, but portable Node path operations are not a sandbox
 * against a malicious same-user process racing ancestor changes.
 */
export async function readPluginManifestFile(absolutePath: string): Promise<{ manifest: SourceManifest; digest: string }> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath) || absolutePath.includes('\0') ||
      absolutePath.split(path.sep).some((part) => part === '.' || part === '..')) fail('PLUGIN_FILE_INVALID')
    const target = path.resolve(absolutePath)
    const parent = path.dirname(target)
    const parents: { name: string; dev: number; ino: number }[] = []
    let current = path.parse(parent).root
    for (const part of ['', ...parent.slice(current.length).split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part)
      const stat = await lstat(current)
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(current) !== current) fail('PLUGIN_FILE_INVALID')
      parents.push({ name: current, dev: stat.dev, ino: stat.ino })
    }
    const before = await lstat(target)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || await realpath(target) !== target) fail('PLUGIN_FILE_INVALID')
    if (before.size > MAX_BYTES) fail('PLUGIN_FILE_LIMIT_EXCEEDED')
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const initial = await file.stat()
    if (!initial.isFile() || !same(before, initial)) fail('PLUGIN_FILE_CHANGED')
    const buffer = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== before.size || !same(initial, await file.stat()) || !same(initial, await lstat(target))) fail('PLUGIN_FILE_CHANGED')
    for (const item of parents) {
      const stat = await lstat(item.name)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino || await realpath(item.name) !== item.name) fail('PLUGIN_FILE_CHANGED')
    }
    let manifest: SourceManifest
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset))
      manifest = parseSourceManifest(JSON.parse(text))
    } catch { fail('PLUGIN_MANIFEST_INVALID') }
    return { manifest, digest: createHash('sha256').update(canonical(manifest)).digest('hex') }
  } catch (error) {
    if (error instanceof PluginInstallError) throw new PluginInstallError(error.code)
    throw new PluginInstallError('PLUGIN_FILE_INVALID')
  } finally {
    await file?.close().catch(() => undefined)
  }
}

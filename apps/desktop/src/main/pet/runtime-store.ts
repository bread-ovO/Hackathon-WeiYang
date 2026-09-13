import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import runtimePins from './runtime-assets.json'
export interface RuntimeAssetPin {
  path: string
  source: string
  bytes: number
  sha256: string
}
export interface RuntimePins {
  version: string
  files: readonly RuntimeAssetPin[]
}
export interface PetResource {
  bytes: Uint8Array
  mime: string
}
export class RuntimeStoreError extends Error {
  constructor() {
    super('PET_RUNTIME_INVALID')
    this.name = 'RuntimeStoreError'
  }
}
export const safeResourcePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\\:%?#\u0000-\u001f\u007f]/u.test(value) &&
  !value.startsWith('/') &&
  value.split('/').every((p) => !!p && p !== '.' && p !== '..')
const hash = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
async function noLinks(path: string, missing = false) {
  let part = resolve(path)
  while (true) {
    try {
      if ((await lstat(part)).isSymbolicLink()) throw new RuntimeStoreError()
    } catch (error) {
      if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
    const parent = dirname(part)
    if (parent === part) break
    part = parent
  }
}
/** Bounded, descriptor-checked file snapshot; rejects detected ancestor or file swaps. */
export async function readPinnedPetFile(
  root: string,
  path: string,
  size: number,
  digest: string,
): Promise<Uint8Array> {
  if (
    !safeResourcePath(path) ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 32 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(digest)
  )
    throw new RuntimeStoreError()
  const directory = resolve(root),
    target = join(directory, path)
  await noLinks(target)
  if ((await realpath(target)) !== target) throw new RuntimeStoreError()
  const chain: { path: string; ino: number; dev: number }[] = []
  let parent = target
  while (true) {
    const stat = await lstat(parent)
    chain.push({ path: parent, ino: stat.ino, dev: stat.dev })
    if (parent === directory) break
    parent = dirname(parent)
  }
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await file.stat(),
      last = chain[0]!
    if (
      !before.isFile() ||
      before.size !== size ||
      before.ino !== last.ino ||
      before.dev !== last.dev
    )
      throw new RuntimeStoreError()
    const bytes = Buffer.alloc(size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (
      offset !== size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new RuntimeStoreError()
    for (const item of chain) {
      const stat = await lstat(item.path)
      if (
        stat.isSymbolicLink() ||
        stat.ino !== item.ino ||
        stat.dev !== item.dev
      )
        throw new RuntimeStoreError()
    }
    if (hash(bytes.subarray(0, size)) !== digest) throw new RuntimeStoreError()
    return Uint8Array.from(bytes.subarray(0, size))
  } finally {
    await file.close()
  }
}
/** trustedPins is an internal fixture seam. Production always uses repository pins, never selected manifests. */
export function createRuntimeStore(
  privateRoot: string,
  trustedPins: RuntimePins = runtimePins,
) {
  const pins = structuredClone(trustedPins)
  if (
    !/^[a-zA-Z0-9_.-]{1,80}$/.test(pins.version) ||
    pins.version === '.' ||
    pins.version === '..' ||
    !Array.isArray(pins.files) ||
    !pins.files.length ||
    pins.files.length > 64 ||
    new Set(pins.files.map((p) => p.path)).size !== pins.files.length ||
    pins.files.some(
      (p) =>
        !safeResourcePath(p.path) ||
        !safeResourcePath(p.source) ||
        !Number.isSafeInteger(p.bytes) ||
        p.bytes < 1 ||
        p.bytes > 32 * 1024 * 1024 ||
        !/^[a-f0-9]{64}$/.test(p.sha256),
    ) ||
    pins.files.reduce((n, p) => n + p.bytes, 0) > 64 * 1024 * 1024
  )
    throw new RuntimeStoreError()
  const root = resolve(privateRoot),
    destination = join(root, pins.version)
  const status = async () => {
    try {
      for (const p of pins.files)
        await readPinnedPetFile(destination, p.path, p.bytes, p.sha256)
      return true
    } catch {
      return false
    }
  }
  let queue: Promise<unknown> = Promise.resolve()
  return {
    status,
    install(sourceDir: string): Promise<void> {
      const source = resolve(sourceDir)
      const operation = queue
        .catch(() => {})
        .then(async () => {
          let stage: string | undefined
          try {
            await noLinks(root, true)
            await mkdir(root, { recursive: true, mode: 0o700 })
            await noLinks(root)
            if (await status()) return
            stage = join(root, `.runtime-${randomUUID()}`)
            await mkdir(stage, { mode: 0o700 })
            for (const p of pins.files) {
              const bytes = await readPinnedPetFile(
                source,
                p.path,
                p.bytes,
                p.sha256,
              )
              const output = join(stage, p.path)
              await mkdir(dirname(output), { recursive: true, mode: 0o700 })
              const file = await open(output, 'wx', 0o600)
              try {
                await file.writeFile(bytes)
                await file.sync()
              } finally {
                await file.close()
              }
            }
            for (const p of pins.files)
              await readPinnedPetFile(stage, p.path, p.bytes, p.sha256)
            if (process.platform !== 'win32') {
              const directories = new Set<string>([stage])
              for (const pin of pins.files) {
                let current = dirname(join(stage, pin.path))
                while (current !== stage) {
                  directories.add(current)
                  current = dirname(current)
                }
              }
              for (const directory of [...directories].sort(
                (a, b) => b.length - a.length,
              )) {
                const handle = await open(directory, 'r')
                try {
                  await handle.sync()
                } finally {
                  await handle.close()
                }
              }
            }
            await noLinks(destination, true)
            // Only an invalid installation is removed; a verified published runtime is immutable.
            await rm(destination, { recursive: true, force: true })
            await rename(stage, destination)
            stage = undefined
            if (process.platform !== 'win32') {
              const directory = await open(root, 'r')
              try {
                await directory.sync()
              } finally {
                await directory.close()
              }
            }
          } catch {
            throw new RuntimeStoreError()
          } finally {
            if (stage)
              await rm(stage, { recursive: true, force: true }).catch(() => {})
          }
        })
      queue = operation
      return operation
    },
    async read(path: string): Promise<PetResource | null> {
      if (
        typeof path !== 'string' ||
        !safeResourcePath(path) ||
        !(
          path === 'core.js' ||
          path === 'framework.js' ||
          (path.startsWith('shaders/') &&
            ['.vert', '.frag'].includes(extname(path)))
        )
      )
        return null
      const pin = pins.files.find((p) => p.path === path)
      if (!pin) return null
      try {
        return {
          bytes: await readPinnedPetFile(
            destination,
            pin.path,
            pin.bytes,
            pin.sha256,
          ),
          mime: path.endsWith('.js') ? 'text/javascript' : 'text/plain',
        }
      } catch {
        return null
      }
    },
  }
}

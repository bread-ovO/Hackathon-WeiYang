import { createHash, randomUUID } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_MODEL_LIMITS,
  validateModelDirectory,
  type ModelIssue,
  type ValidatedModelResource,
} from './model-validation'

export interface StoredModel {
  id: string
  entry: string
  importedAt: string
  totalBytes: number
  resources: ValidatedModelResource[]
}
export interface ModelStoreSnapshot {
  currentModelId: string | null
  models: StoredModel[]
}
export type ModelImportResult =
  | { status: 'imported' | 'duplicate'; model: StoredModel }
  | { status: 'invalid'; issues: ModelIssue[] }
export class ModelStoreError extends Error {
  constructor(
    readonly code:
      | 'source-changed'
      | 'invalid-store'
      | 'unknown-model'
      | 'storage-limit'
      | 'outcome-unknown',
    message: string,
  ) {
    super(message)
    this.name = 'ModelStoreError'
  }
}
const idPattern = /^[a-f0-9]{64}$/u
const safeRelative = (value: string) =>
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\\:%?#\x00-\x1f\x7f]/u.test(value) &&
  !path.posix.isAbsolute(value) &&
  value
    .split('/')
    .every((part) => part !== '..' && part !== '.' && part.length > 0)
function canonicalLocation(directory: string): string {
  const absolute = path.resolve(directory)
  const parent = path.dirname(absolute)
  if (parent === absolute) return absolute
  let canonicalParent: string
  try {
    canonicalParent = realpathSync(parent)
  } catch {
    canonicalParent = canonicalLocation(parent)
  }
  return path.join(canonicalParent, path.basename(absolute))
}
const registryLimit = 8 * 1024 * 1024
const maxModels = 64
// One owning worker/process. This queue also serializes distinct instances in that process.
const queues = new Map<string, Promise<unknown>>()
function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  queues.set(key, next)
  void next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key)
    })
    .catch(() => undefined)
  return next
}
const digest = (entry: string, resources: ValidatedModelResource[]) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        entry,
        resources: [...resources]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((item) => [item.path, item.kind, item.bytes, item.sha256]),
      }),
    )
    .digest('hex')
const clone = <T>(value: T): T => structuredClone(value)

/** Persistent model asset storage for one owning worker/utilityProcess, not the UI thread.
 * The root must be an application-owned private directory, never the user-selected model root.
 * Validation is preflight only (not Cubism compatibility); no model code is loaded or executed.
 * No cross-process locking: host must route all access through the same owning process.
 * Descriptor/parent checks reject detected swaps, but Node cannot provide a portable openat
 * sandbox against a malicious same-user process continuously swapping ancestor directories.
 */
export class ModelStore {
  private readonly root: string
  constructor(directory: string) {
    this.root = canonicalLocation(directory)
  }

  async list(): Promise<ModelStoreSnapshot> {
    return serial(this.root, async () => clone(await this.recover()))
  }

  /** Imports and registers assets; selection is explicit so failed/duplicate imports cannot switch pets. */
  async importModel(
    sourceDirectory: string,
    entry: string,
  ): Promise<ModelImportResult> {
    return serial(this.root, async () => {
      const state = await this.recover()
      const validation = await validateModelDirectory(sourceDirectory, entry)
      if (!validation.ok)
        return { status: 'invalid', issues: validation.issues }
      const source = await realpath(sourceDirectory)
      if (
        source === this.root ||
        source.startsWith(`${this.root}${path.sep}`) ||
        this.root.startsWith(`${source}${path.sep}`)
      ) {
        throw new ModelStoreError(
          'invalid-store',
          '源模型目录与受控存储目录不能重叠。',
        )
      }
      const id = digest(entry, validation.resources)
      const existing = state.models.find((model) => model.id === id)
      if (existing) return { status: 'duplicate', model: clone(existing) }
      if (state.models.length >= maxModels)
        throw new ModelStoreError(
          'storage-limit',
          '最多保存 64 个模型，请先移除不再使用的模型。',
        )
      const stage = path.join(this.root, `.staging-${randomUUID()}`)
      const destination = path.join(this.root, id)
      await mkdir(stage, { mode: 0o700 })
      let published = false
      try {
        for (const resource of validation.resources) {
          const bytes = await readSourceSnapshot(source, resource)
          const output = path.join(stage, resource.path)
          await mkdir(path.dirname(output), { recursive: true, mode: 0o700 })
          const file = await open(output, 'wx', 0o600)
          try {
            await file.writeFile(bytes)
            await file.sync()
          } finally {
            await file.close()
          }
        }
        const copied = await validateModelDirectory(stage, entry)
        if (!copied.ok || digest(entry, copied.resources) !== id)
          throw new ModelStoreError(
            'source-changed',
            '复制后的模型与已校验资源不一致，未导入。',
          )
        await syncTreeDirectories(stage)
        await rename(stage, destination)
        published = true
        await syncDirectory(this.root)
        const model: StoredModel = {
          id,
          entry,
          importedAt: new Date().toISOString(),
          totalBytes: copied.totalBytes,
          resources: copied.resources,
        }
        await this.writeState({ ...state, models: [...state.models, model] })
        return { status: 'imported', model: clone(model) }
      } catch (error) {
        // A publish with no registry commit is an orphan; next recovery removes it too.
        if (published) {
          try {
            const persisted = await this.readState()
            if (!persisted.models.some((model) => model.id === id))
              await rm(destination, { recursive: true, force: true })
          } catch {
            // Cleanup/reconciliation must not replace the original failure.
            // Unknown publication remains for the next recovery pass.
          }
        }
        throw error
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  async select(id: string | null): Promise<ModelStoreSnapshot> {
    return serial(this.root, async () => {
      const state = await this.recover()
      if (id !== null && !state.models.some((model) => model.id === id))
        throw new ModelStoreError('unknown-model', '模型不存在或已损坏。')
      const next = { ...state, currentModelId: id }
      await this.writeState(next)
      return clone(next)
    })
  }

  async remove(id: string): Promise<ModelStoreSnapshot> {
    return serial(this.root, async () => {
      const state = await this.recover()
      if (!state.models.some((model) => model.id === id))
        throw new ModelStoreError('unknown-model', '模型不存在。')
      const next = {
        currentModelId:
          state.currentModelId === id ? null : state.currentModelId,
        models: state.models.filter((model) => model.id !== id),
      }
      // Commit logical deletion before removing bytes; interrupted cleanup leaves only an orphan.
      await this.writeState(next)
      // Logical deletion is committed. Cleanup failure leaves an orphan, not
      // a failed deletion or a promise that the previous selection survived.
      try {
        await rm(path.join(this.root, id), { recursive: true, force: true })
        await syncDirectory(this.root)
      } catch { /* recover retries orphan cleanup without resurrecting the model. */ }
      return clone(next)
    })
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const info = await lstat(this.root)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(this.root)) !== this.root
    )
      throw new ModelStoreError(
        'invalid-store',
        '存储目录不能通过符号链接访问。',
      )
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new ModelStoreError(
        'invalid-store',
        '存储目录必须是仅当前用户可访问的私有目录。',
      )
  }

  private async readState(): Promise<ModelStoreSnapshot> {
    const filePath = path.join(this.root, 'registry.json')
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(
        filePath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { currentModelId: null, models: [] }
      throw new ModelStoreError('invalid-store', '无法安全读取模型注册表。')
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > registryLimit)
        throw new Error('registry-size')
      const bytes = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        )
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length !== stat.size) throw new Error('registry-changed')
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      )
      if (!validState(value)) throw new Error('registry-shape')
      return value
    } catch {
      throw new ModelStoreError(
        'invalid-store',
        '模型注册表损坏；保留原数据，未重置。',
      )
    } finally {
      await file.close()
    }
  }

  private async writeState(state: ModelStoreSnapshot): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(state))
    if (bytes.length > registryLimit)
      throw new ModelStoreError('storage-limit', '模型注册表超过容量限制。')
    const temporary = path.join(this.root, `.registry-${randomUUID()}`)
    let committed = false
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path.join(this.root, 'registry.json'))
      committed = true
      await syncDirectory(this.root)
    } catch (error) {
      if (committed)
        throw new ModelStoreError('outcome-unknown', '提交结果需要重新读取确认。')
      throw error
    } finally {
      try { await rm(temporary, { force: true }) } catch {
        if (committed)
          throw new ModelStoreError('outcome-unknown', '提交结果需要重新读取确认。')
        // Preserve the pre-commit failure; recovery will remove a leftover temp.
      }
    }
  }

  private async recover(): Promise<ModelStoreSnapshot> {
    await this.initialize()
    const state = await this.readState()
    const healthy: StoredModel[] = []
    for (const model of state.models) {
      const directory = path.join(this.root, model.id)
      try {
        if (!(await lstat(directory)).isDirectory()) continue
        const checked = await validateModelDirectory(directory, model.entry)
        if (checked.ok && digest(model.entry, checked.resources) === model.id)
          healthy.push(model)
      } catch {
        /* Missing/changed asset directories are not selectable. */
      }
    }
    const next = {
      currentModelId: healthy.some((model) => model.id === state.currentModelId)
        ? state.currentModelId
        : null,
      models: healthy,
    }
    if (
      healthy.length !== state.models.length ||
      next.currentModelId !== state.currentModelId
    )
      await this.writeState(next)
    const registered = new Set(healthy.map((model) => model.id))
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      if (
        /^\.(?:staging|registry)-[a-f0-9-]{36}$/u.test(name) ||
        (idPattern.test(name) && !registered.has(name))
      ) {
        await rm(path.join(this.root, name), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return next
  }
}

function validState(value: unknown): value is ModelStoreSnapshot {
  if (!value || typeof value !== 'object') return false
  const state = value as ModelStoreSnapshot
  if (
    !Array.isArray(state.models) ||
    state.models.length > maxModels ||
    (state.currentModelId !== null &&
      (typeof state.currentModelId !== 'string' ||
        !idPattern.test(state.currentModelId)))
  )
    return false
  const seen = new Set<string>()
  for (const model of state.models) {
    if (
      !model ||
      typeof model.id !== 'string' ||
      !idPattern.test(model.id) ||
      seen.has(model.id) ||
      typeof model.entry !== 'string' ||
      !safeRelative(model.entry) ||
      !model.entry.endsWith('.model3.json') ||
      typeof model.importedAt !== 'string' ||
      !Number.isFinite(Date.parse(model.importedAt)) ||
      !Number.isSafeInteger(model.totalBytes) ||
      model.totalBytes <= 0 ||
      model.totalBytes > DEFAULT_MODEL_LIMITS.totalBytes ||
      !Array.isArray(model.resources) ||
      model.resources.length > DEFAULT_MODEL_LIMITS.fileCount ||
      model.resources.length < 1
    )
      return false
    seen.add(model.id)
    const paths = new Set<string>()
    for (const resource of model.resources) {
      if (
        !resource ||
        typeof resource.path !== 'string' ||
        !safeRelative(resource.path) ||
        paths.has(resource.path) ||
        typeof resource.kind !== 'string' ||
        resource.kind.length > 32 ||
        !Number.isSafeInteger(resource.bytes) ||
        resource.bytes <= 0 ||
        resource.bytes > DEFAULT_MODEL_LIMITS.fileBytes ||
        typeof resource.sha256 !== 'string' ||
        !idPattern.test(resource.sha256)
      )
        return false
      paths.add(resource.path)
    }
    if (
      digest(model.entry, model.resources) !== model.id ||
      model.totalBytes !==
        model.resources.reduce((sum, resource) => sum + resource.bytes, 0)
    )
      return false
  }
  return true
}

async function readSourceSnapshot(
  root: string,
  resource: ValidatedModelResource,
): Promise<Buffer> {
  const changed = () =>
    new ModelStoreError(
      'source-changed',
      '源资源在校验后发生变化，请重新导入。',
    )
  const parents: { target: string; ino: number; dev: number }[] = []
  let target = root
  for (const part of ['', ...resource.path.split('/')]) {
    target = part ? path.join(target, part) : target
    const stat = await lstat(target)
    if (stat.isSymbolicLink() || (await realpath(target)) !== target)
      throw changed()
    parents.push({ target, ino: stat.ino, dev: stat.dev })
  }
  const file = await open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const before = await file.stat()
    const last = parents.at(-1)!
    if (
      !before.isFile() ||
      before.ino !== last.ino ||
      before.dev !== last.dev ||
      before.size !== resource.bytes ||
      before.size > DEFAULT_MODEL_LIMITS.fileBytes
    )
      throw changed()
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (
      offset !== resource.bytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw changed()
    for (const parent of parents) {
      const stat = await lstat(parent.target)
      if (
        stat.isSymbolicLink() ||
        stat.ino !== parent.ino ||
        stat.dev !== parent.dev ||
        (await realpath(parent.target)) !== parent.target
      )
        throw changed()
    }
    const content = bytes.subarray(0, offset)
    if (createHash('sha256').update(content).digest('hex') !== resource.sha256)
      throw changed()
    return content
  } finally {
    await file.close()
  }
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return // Windows directory fsync unsupported; rename remains atomic.
  const file = await open(directory, 'r')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}
async function syncTreeDirectories(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      await syncTreeDirectories(path.join(directory, entry.name))
  }
  await syncDirectory(directory)
}

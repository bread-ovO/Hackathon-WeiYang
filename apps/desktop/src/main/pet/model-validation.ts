import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

export interface ModelValidationLimits {
  manifestBytes: number
  fileCount: number
  fileBytes: number
  totalBytes: number
  textureDimension: number
  texturePixels: number
}
export const DEFAULT_MODEL_LIMITS: Readonly<ModelValidationLimits> =
  Object.freeze({
    manifestBytes: 1024 * 1024,
    fileCount: 256,
    fileBytes: 32 * 1024 * 1024,
    totalBytes: 128 * 1024 * 1024,
    textureDimension: 8192,
    texturePixels: 16 * 1024 * 1024,
  })
export type ModelIssueCode =
  | 'invalid-root'
  | 'invalid-path'
  | 'symlink'
  | 'missing'
  | 'not-file'
  | 'read-failed'
  | 'limit'
  | 'invalid-json'
  | 'invalid-manifest'
  | 'invalid-resource'
  | 'unsupported-resource'
export interface ModelIssue {
  code: ModelIssueCode
  resource: string
  message: string
}
export interface ValidatedModelResource {
  sha256: string
  path: string
  kind: string
  bytes: number
}
export interface ModelValidationResult {
  ok: boolean
  issues: ModelIssue[]
  resources: ValidatedModelResource[]
  totalBytes: number
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const safeRelative = (value: string) =>
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\\:%?#\x00-\x1f\x7f]/u.test(value) &&
  !path.posix.isAbsolute(value) &&
  value
    .split('/')
    .every((part) => part !== '..' && part !== '.' && part.length > 0)
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/** Read-only preflight, not an import authorization or SDK compatibility guarantee.
 * Caller supplies a user-selected directory and relative model entry. Revalidate copied bytes
 * in a private staging directory before publication: source files can change after this returns.
 * CRC and bounded decompression are CPU work: run in a worker/utilityProcess on integration,
 * never directly on the Electron UI main thread. ok means preflight only, not renderability.
 * Conservative profile: Cubism 3 manifests, PNG textures (8-bit, non-interlaced), WAV audio.
 */
export async function validateModelDirectory(
  directory: string,
  entry: string,
  overrides: Partial<ModelValidationLimits> = {},
): Promise<ModelValidationResult> {
  const limits = { ...DEFAULT_MODEL_LIMITS, ...overrides }
  for (const key of Object.keys(limits) as (keyof ModelValidationLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] <= 0 ||
      limits[key] > DEFAULT_MODEL_LIMITS[key]
    ) {
      throw new RangeError(`Invalid model validation limit: ${key}`)
    }
  }
  const result: ModelValidationResult = {
    ok: false,
    issues: [],
    resources: [],
    totalBytes: 0,
  }
  const issue = (code: ModelIssueCode, resource: string, message: string) => {
    if (result.issues.length < limits.fileCount)
      result.issues.push({ code, resource, message })
  }
  let root: string
  try {
    root = await realpath(directory)
    if (!(await lstat(root)).isDirectory()) throw new Error('not-directory')
  } catch {
    issue('invalid-root', '', '请选择可读取的模型目录。')
    return result
  }
  if (!safeRelative(entry) || !entry.endsWith('.model3.json')) {
    issue('invalid-path', entry, '入口必须是目录内的相对 .model3.json 路径。')
    return result
  }
  // Bounded reads via descriptor: never readFile an attacker-controlled growing file.
  const read = async (
    relative: string,
    maxBytes: number,
  ): Promise<Buffer | undefined> => {
    if (!safeRelative(relative)) {
      issue(
        'invalid-path',
        relative,
        '资源路径不能包含绝对路径、URL、编码路径或上级目录。',
      )
      return
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      let current = root
      for (const part of relative.split('/')) {
        current = path.join(current, part)
        if ((await lstat(current)).isSymbolicLink()) {
          issue('symlink', relative, '模型资源不支持符号链接。')
          return
        }
      }
      const target = path.join(root, relative)
      if (!inside(root, await realpath(target))) {
        issue('invalid-path', relative, '资源越过已选择目录。')
        return
      }
      handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const stat = await handle.stat()
      // Check both path containment and inode after open; reject detected replacement races.
      const resolved = await realpath(target)
      const currentStat = await lstat(target)
      if (
        !inside(root, resolved) ||
        stat.ino !== currentStat.ino ||
        stat.dev !== currentStat.dev
      ) {
        issue('invalid-path', relative, '校验时资源路径发生变化。')
        return
      }
      if (!stat.isFile()) {
        issue('not-file', relative, '资源必须是普通文件。')
        return
      }
      if (
        stat.size === 0 ||
        stat.size > maxBytes ||
        result.totalBytes + stat.size > limits.totalBytes
      ) {
        issue('limit', relative, '资源为空或超过文件/总容量限制。')
        return
      }
      const bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const chunk = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        )
        if (!chunk.bytesRead) break
        offset += chunk.bytesRead
      }
      const after = await handle.stat()
      if (
        offset !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.size !== stat.size
      ) {
        issue('read-failed', relative, '校验过程中资源发生变化，请重试。')
        return
      }
      result.totalBytes += offset
      return bytes.subarray(0, offset)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      issue(
        code === 'ENOENT'
          ? 'missing'
          : code === 'ELOOP'
            ? 'symlink'
            : 'read-failed',
        relative,
        code === 'ENOENT' ? '找不到引用的资源。' : '无法安全读取资源。',
      )
      return
    } finally {
      await handle?.close()
    }
  }
  const json = (
    bytes: Buffer,
    relative: string,
  ): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      )
      if (!record(value)) throw new Error('not-object')
      return value
    } catch {
      issue('invalid-json', relative, '文件必须是有效 UTF-8 JSON 对象。')
      return
    }
  }
  const manifestBytes = await read(
    entry,
    Math.min(limits.manifestBytes, limits.fileBytes),
  )
  if (!manifestBytes) return result
  const manifest = json(manifestBytes, entry)
  if (!manifest) return result
  const refs = manifest.FileReferences
  if (manifest.Version !== 3 || !record(refs)) {
    issue('invalid-manifest', entry, '需要 Version 3 和 FileReferences 对象。')
    return result
  }
  const references: { value: string; kind: string; suffix: string }[] = []
  const countedReferences = new Set<string>([entry])
  let referenceCount = 1
  const add = (value: unknown, kind: string, suffix: string) => {
    if (typeof value !== 'string' || !value) {
      issue('invalid-manifest', entry, `${kind} 引用必须为非空字符串。`)
      return
    }
    if (!countedReferences.has(value)) {
      countedReferences.add(value)
      referenceCount++
    }
    if (referenceCount > limits.fileCount) return
    references.push({ value, kind, suffix })
  }
  const known = new Set([
    'Moc',
    'Textures',
    'Physics',
    'Pose',
    'UserData',
    'DisplayInfo',
    'Expressions',
    'Motions',
  ])
  for (const key of Object.keys(refs)) {
    if (!known.has(key))
      issue('unsupported-resource', entry, `不支持的资源字段：${key}`)
  }
  add(refs.Moc, 'moc', '.moc3')
  if (!Array.isArray(refs.Textures) || !refs.Textures.length) {
    issue('invalid-manifest', entry, 'Textures 必须是非空数组。')
  } else refs.Textures.forEach((value) => add(value, 'texture', '.png'))
  for (const [key, suffix] of Object.entries({
    Physics: '.physics3.json',
    Pose: '.pose3.json',
    UserData: '.userdata3.json',
    DisplayInfo: '.cdi3.json',
  })) {
    if (key in refs) add(refs[key], key, suffix)
  }
  if ('Expressions' in refs) {
    if (!Array.isArray(refs.Expressions))
      issue('invalid-manifest', entry, 'Expressions 必须是数组。')
    else
      for (const expression of refs.Expressions) {
        if (
          !record(expression) ||
          typeof expression.Name !== 'string' ||
          !expression.Name
        ) {
          issue('invalid-manifest', entry, '表情需要 Name 和 File。')
          continue
        }
        add(expression.File, 'expression', '.exp3.json')
      }
  }
  if ('Motions' in refs) {
    if (!record(refs.Motions))
      issue('invalid-manifest', entry, 'Motions 必须是分组对象。')
    else
      for (const motions of Object.values(refs.Motions)) {
        if (!Array.isArray(motions)) {
          issue('invalid-manifest', entry, '动作分组必须是数组。')
          continue
        }
        for (const motion of motions) {
          if (!record(motion)) {
            issue('invalid-manifest', entry, '动作必须是对象。')
            continue
          }
          add(motion.File, 'motion', '.motion3.json')
          if ('Sound' in motion) add(motion.Sound, 'sound', '.wav')
        }
      }
  }
  if (referenceCount > limits.fileCount) {
    issue('limit', entry, '模型引用数量超过限制。')
    return result
  }
  result.resources.push({
    sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    path: entry,
    kind: 'manifest',
    bytes: manifestBytes.length,
  })
  const seen = new Set([entry])
  for (const ref of references) {
    if (!safeRelative(ref.value)) {
      issue('invalid-path', ref.value, '资源引用必须是安全的目录内相对路径。')
      continue
    }
    if (!ref.value.endsWith(ref.suffix)) {
      issue(
        'unsupported-resource',
        ref.value,
        `该资源必须使用 ${ref.suffix} 格式。`,
      )
      continue
    }
    const relative = path.posix.join(path.posix.dirname(entry), ref.value)
    if (seen.has(relative)) continue
    seen.add(relative)
    const bytes = await read(
      relative,
      ref.suffix.endsWith('.json')
        ? Math.min(limits.manifestBytes, limits.fileBytes)
        : limits.fileBytes,
    )
    if (!bytes) continue
    const issuesBefore = result.issues.length
    if (ref.kind === 'texture') {
      try {
        validatePng(bytes, limits)
      } catch {
        issue(
          'invalid-resource',
          relative,
          'PNG 损坏或超过像素上限；仅支持 8-bit 非隔行灰度/RGB/RGBA，暂不支持索引色。',
        )
      }
    } else if (ref.kind === 'moc') {
      if (bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'MOC3')
        issue(
          'invalid-resource',
          relative,
          '缺少 MOC3 文件头；完整兼容性仍需 Cubism 校验。',
        )
    } else if (ref.kind === 'sound') {
      if (
        bytes.length < 12 ||
        bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WAVE'
      )
        issue('invalid-resource', relative, '不是 WAV 音频文件。')
    } else json(bytes, relative)
    if (issuesBefore === result.issues.length)
      result.resources.push({
        sha256: createHash('sha256').update(bytes).digest('hex'),
        path: relative,
        kind: ref.kind,
        bytes: bytes.length,
      })
  }
  result.ok = result.issues.length === 0
  return result
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function validatePng(bytes: Buffer, limits: ModelValidationLimits): void {
  const fail = () => {
    throw new Error('invalid-png')
  }
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    fail()
  let offset = 8,
    expected = 0,
    rowBytes = 0,
    height = 0,
    ended = false,
    idatEnded = false
  const data: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (offset + 12 + length > bytes.length) fail()
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const payload = bytes.subarray(offset + 8, offset + 8 + length)
    if (
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      fail()
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) fail()
      const width = payload.readUInt32BE(0)
      height = payload.readUInt32BE(4)
      const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
        payload[9]!
      ]
      if (
        !width ||
        !height ||
        width > limits.textureDimension ||
        height > limits.textureDimension ||
        width * height > limits.texturePixels ||
        !channels ||
        payload[8] !== 8 ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      )
        fail()
      rowBytes = width * channels! + 1
      expected = rowBytes * height
    } else if (type === 'IHDR') fail()
    else if (type === 'IDAT') {
      if (idatEnded) fail()
      data.push(payload)
    } else {
      if (data.length) idatEnded = true
      if (type === 'IEND') {
        if (length !== 0 || offset + 12 !== bytes.length) fail()
        ended = true
        break
      }
      if (!/^[a-z]/u.test(type) && type !== 'PLTE') fail()
    }
    offset += 12 + length
  }
  if (!ended || !data.length || !expected) fail()
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected })
  if (pixels.length !== expected) fail()
  for (let row = 0; row < height; row++) if (pixels[row * rowBytes]! > 4) fail()
}

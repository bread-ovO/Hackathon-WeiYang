import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import nodePath from 'node:path'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
import {
  LOCAL_JSONL_MANIFEST_EXAMPLE,
  parseSourceManifest,
  type SourceManifest,
} from './manifest'

export type LocalJsonlErrorCode =
  | 'FILE_UNAVAILABLE'
  | 'UNSAFE_PATH'
  | 'FILE_TOO_LARGE'
  | 'LINE_TOO_LARGE'
  | 'FILE_CHANGED'
  | 'INVALID_UTF8'
  | 'INVALID_JSONL'
  | 'INVALID_SOURCE_EVENT'
  | 'INVALID_CURSOR'
  | 'INVALID_MANIFEST'
export class LocalJsonlError extends Error {
  constructor(readonly code: LocalJsonlErrorCode) {
    super(code)
    this.name = 'LocalJsonlError'
  }
}
export interface LocalJsonlCursor {
  version: 1
  fileIdentity: string
  offset: number
  prefixSha256: string
  selectionSha256: string
  mappingSha256: string
}
export interface LocalJsonlInput {
  /** Exact file selected/authorized by the trusted host, never a renderer-supplied path. */
  path: string
  sourceInstanceId: string
  cursor?: LocalJsonlCursor | null
  manifest?: unknown
  /** Optional pure normalizer applied to each parsed record before manifest
   * mapping; returning null skips the line without consuming batch budget. */
  normalizeRecord?: (record: Record<string, unknown>) => unknown
  /** Stable versioned identity of normalizeRecord, mixed into the mapping
   * fingerprint so a changed normalizer rescans instead of resuming stale. */
  normalizerId?: string
}
export interface LocalJsonlBatch {
  events: SourceEvent[]
  cursor: LocalJsonlCursor
  done: boolean
}
export const BUILTIN_JSONL_MANIFEST = {
  ...LOCAL_JSONL_MANIFEST_EXAMPLE,
  id: 'builtin-jsonl',
  mapping: {
    ...LOCAL_JSONL_MANIFEST_EXAMPLE.mapping,
    role: { pointer: '/role' },
  },
  transport: {
    ...LOCAL_JSONL_MANIFEST_EXAMPLE.transport,
    maxFileBytes: 16 * 1024 * 1024,
  },
} as const
const hash = (data: string | Buffer) =>
  createHash('sha256').update(data).digest('hex')
const shaPattern = /^[a-f0-9]{64}$/u
function validCursor(value: unknown): value is LocalJsonlCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const cursor = value as LocalJsonlCursor
  return (
    Object.keys(value).length === 6 &&
    cursor.version === 1 &&
    Number.isSafeInteger(cursor.offset) &&
    cursor.offset >= 0 &&
    cursor.offset <= 16 * 1024 * 1024 &&
    [
      cursor.fileIdentity,
      cursor.prefixSha256,
      cursor.selectionSha256,
      cursor.mappingSha256,
    ].every((value) => typeof value === 'string' && shaPattern.test(value))
  )
}
const ownObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
function selectPointer(record: unknown, pointer: string): unknown {
  let selected = record
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (
      ['__proto__', 'prototype', 'constructor'].includes(key) ||
      selected === null ||
      typeof selected !== 'object' ||
      !Object.hasOwn(selected, key)
    )
      throw new LocalJsonlError('INVALID_SOURCE_EVENT')
    selected = (selected as Record<string, unknown>)[key]
  }
  return selected
}
function mapRecord(
  record: unknown,
  manifest: SourceManifest,
  sourceInstanceId: string,
  builtin: boolean,
): SourceEvent {
  if (!ownObject(record)) throw new LocalJsonlError('INVALID_JSONL')
  const mapped: Record<string, unknown> = { schemaVersion: 1, sourceInstanceId }
  for (const [key, selector] of Object.entries(manifest.mapping)) {
    mapped[key] =
      'pointer' in selector
        ? selectPointer(record, selector.pointer)
        : selector.constant
  }
  // Built-in v1 records gain an optional explicit operation without changing the
  // legacy mapping fingerprint: old append-only cursors remain valid. Custom
  // manifests require an explicit selector and never inherit this capability.
  if (builtin && Object.hasOwn(record, 'operation'))
    mapped.operation = record.operation
  try {
    return parseSourceEvent(mapped)
  } catch {
    throw new LocalJsonlError('INVALID_SOURCE_EVENT')
  }
}

/** Bounded single-file reader. No directory scan, code execution, network or database writes.
 * The exact user-selected path is the grant. Manifest directory/file templates never expand it;
 * only the mapping, record limits and capacity limits are used for this single-file operation.
 * The host must commit events + cursor atomically and serialize/CAS consumption per source.
 * `done` means no more COMPLETE records in the current snapshot, not a completed business task.
 * A final line lacking LF is retained at its start offset, including an incomplete UTF-8 codepoint.
 * Directory/descriptor identity checks reject detected swaps; not a portable openat sandbox
 * against a malicious same-user process continuously replacing ancestors.
 */
export async function readLocalJsonl(
  input: LocalJsonlInput,
): Promise<LocalJsonlBatch> {
  let manifest: SourceManifest
  try {
    manifest = parseSourceManifest(input.manifest ?? BUILTIN_JSONL_MANIFEST)
    if (manifest.kind !== 'local-jsonl') throw new Error('unsupported-kind')
  } catch {
    throw new LocalJsonlError('INVALID_MANIFEST')
  }
  if (
    typeof input.sourceInstanceId !== 'string' ||
    input.sourceInstanceId.length < 1 ||
    input.sourceInstanceId.length > 128
  )
    throw new LocalJsonlError('INVALID_SOURCE_EVENT')
  if (
    (input.normalizeRecord == null) !== (input.normalizerId == null) ||
    (input.normalizerId != null &&
      (typeof input.normalizerId !== 'string' ||
        input.normalizerId.length < 1 ||
        input.normalizerId.length > 128)) ||
    (input.normalizeRecord != null && typeof input.normalizeRecord !== 'function')
  )
    throw new LocalJsonlError('INVALID_MANIFEST')
  if (input.cursor != null && !validCursor(input.cursor))
    throw new LocalJsonlError('INVALID_CURSOR')
  if (
    typeof input.path !== 'string' ||
    !nodePath.isAbsolute(input.path) ||
    input.path.includes('\0') ||
    input.path
      .split(nodePath.sep)
      .some((part) => part === '..' || part === '.') ||
    nodePath.extname(input.path).toLowerCase() !== '.jsonl'
  )
    throw new LocalJsonlError('UNSAFE_PATH')
  const selectedPath = nodePath.resolve(input.path)
  const selectionSha256 = hash(selectedPath)
  const mappingSha256 = hash(
    JSON.stringify(
      // Without a normalizer the fingerprint keeps its exact legacy shape so
      // existing cursors stay valid.
      input.normalizerId == null
        ? {
            mapping: manifest.mapping,
            sourceInstanceId: input.sourceInstanceId,
          }
        : {
            mapping: manifest.mapping,
            sourceInstanceId: input.sourceInstanceId,
            normalizerId: input.normalizerId,
          },
    ),
  )
  const fileLimit = Math.min(16 * 1024 * 1024, manifest.transport.maxFileBytes)
  const lineLimit = Math.min(128 * 1024, manifest.transport.maxLineBytes)
  const batchLimit = Math.min(100, manifest.sampling.maxRecordsPerRun)
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    const identities: { path: string; dev: number; ino: number }[] = []
    let current = nodePath.parse(selectedPath).root
    for (const segment of selectedPath
      .slice(current.length)
      .split(nodePath.sep)) {
      current = nodePath.join(current, segment)
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || (await realpath(current)) !== current)
        throw new LocalJsonlError('UNSAFE_PATH')
      identities.push({ path: current, dev: stat.dev, ino: stat.ino })
    }
    file = await open(
      selectedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    const before = await file.stat()
    const last = identities.at(-1)
    if (!before.isFile() || before.ino !== last?.ino || before.dev !== last.dev)
      throw new LocalJsonlError('UNSAFE_PATH')
    if (before.size > fileLimit) throw new LocalJsonlError('FILE_TOO_LARGE')
    const bytes = Buffer.alloc(before.size + 1)
    let readBytes = 0
    while (readBytes < bytes.length) {
      const read = await file.read(
        bytes,
        readBytes,
        bytes.length - readBytes,
        readBytes,
      )
      if (!read.bytesRead) break
      readBytes += read.bytesRead
    }
    const after = await file.stat()
    if (
      readBytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new LocalJsonlError('FILE_CHANGED')
    for (const identity of identities) {
      const stat = await lstat(identity.path)
      if (
        stat.isSymbolicLink() ||
        stat.ino !== identity.ino ||
        stat.dev !== identity.dev ||
        (await realpath(identity.path)) !== identity.path
      )
        throw new LocalJsonlError('FILE_CHANGED')
    }
    const content = bytes.subarray(0, readBytes)
    const fileIdentity = hash(
      `${before.dev}:${before.ino}:${before.birthtimeMs}`,
    )
    let offset = 0
    const previous = input.cursor
    if (
      previous &&
      previous.fileIdentity === fileIdentity &&
      previous.selectionSha256 === selectionSha256 &&
      previous.mappingSha256 === mappingSha256 &&
      previous.offset <= content.length &&
      (previous.offset === 0 || content[previous.offset - 1] === 10) &&
      hash(content.subarray(0, previous.offset)) === previous.prefixSha256
    )
      offset = previous.offset
    const events: SourceEvent[] = []
    let batchTextLength = 0
    while (offset < content.length && events.length < batchLimit) {
      const newline = content.indexOf(10, offset)
      if (newline < 0) {
        if (content.length - offset > lineLimit)
          throw new LocalJsonlError('LINE_TOO_LARGE')
        break
      }
      if (newline - offset > lineLimit)
        throw new LocalJsonlError('LINE_TOO_LARGE')
      const end = content[newline - 1] === 13 ? newline - 1 : newline
      let text: string
      try {
        text = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(content.subarray(offset, end))
      } catch {
        throw new LocalJsonlError('INVALID_UTF8')
      }
      let record: unknown
      try {
        record = JSON.parse(text)
      } catch {
        throw new LocalJsonlError('INVALID_JSONL')
      }
      if (input.normalizeRecord) {
        if (!ownObject(record)) throw new LocalJsonlError('INVALID_JSONL')
        try {
          record = input.normalizeRecord(record)
        } catch {
          throw new LocalJsonlError('INVALID_SOURCE_EVENT')
        }
        // A skipped line is still confirmed consumed: it never enters a batch.
        if (record === null) {
          offset = newline + 1
          continue
        }
      }
      const event = mapRecord(
        record,
        manifest,
        input.sourceInstanceId,
        input.manifest == null,
      )
      // Match receiveBatch's UTF-16 string-length budget. Leave this complete line
      // unconfirmed when it belongs in the next batch. One valid event is <= 65536.
      if (batchTextLength + event.text.length > 4 * 1024 * 1024) break
      events.push(event)
      batchTextLength += event.text.length
      offset = newline + 1
    }
    // If a batch ends before further complete lines, parent can request another batch.
    const done = content.indexOf(10, offset) < 0
    return {
      events,
      cursor: {
        version: 1,
        fileIdentity,
        offset,
        prefixSha256: hash(content.subarray(0, offset)),
        selectionSha256,
        mappingSha256,
      },
      done,
    }
  } catch (error) {
    if (error instanceof LocalJsonlError) throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new LocalJsonlError(
      code === 'ELOOP' ? 'UNSAFE_PATH' : 'FILE_UNAVAILABLE',
    )
  } finally {
    await file?.close()
  }
}

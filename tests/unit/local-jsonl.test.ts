import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  BUILTIN_JSONL_MANIFEST,
  LocalJsonlError,
  readLocalJsonl,
} from '../../packages/plugin-host/src/local-jsonl'
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
}))
let directory: string, file: string
const event = (id = 'event-1', role = 'user') => ({
  id,
  revision: '1',
  created_at: '2026-09-13T01:00:00Z',
  role,
  content: '合成事项',
})
const line = (value: unknown) => `${JSON.stringify(value)}\n`
const input = () => ({ path: file, sourceInstanceId: 'test-source' })
beforeEach(async () => {
  directory = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), 'bugu-jsonl-')),
  )
  file = path.join(directory, 'events.jsonl')
  await fs.writeFile(file, '')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('bounded authorized JSONL reader', () => {
  it('preserves every supported role and injects host identity', async () => {
    await fs.writeFile(
      file,
      ['user', 'assistant', 'tool', 'system']
        .map((role) =>
          line({
            ...event(role, role),
            sourceInstanceId: 'attacker',
            schemaVersion: 99,
          }),
        )
        .join(''),
    )
    const result = await readLocalJsonl(input())
    expect(result.events.map((value) => value.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'system',
    ])
    expect(
      result.events.every(
        (value) =>
          value.sourceInstanceId === 'test-source' && value.schemaVersion === 1,
      ),
    ).toBe(true)
    expect(result.done).toBe(true)
  })
  it('returns at most 100 records and advances only committed complete lines', async () => {
    await fs.writeFile(
      file,
      Array.from({ length: 205 }, (_, id) => line(event(String(id)))).join(''),
    )
    const first = await readLocalJsonl(input())
    expect(first.events).toHaveLength(100)
    expect(first.done).toBe(false)
    const second = await readLocalJsonl({ ...input(), cursor: first.cursor })
    expect(second.events).toHaveLength(100)
    expect(second.events[0]?.externalId).toBe('100')
    const third = await readLocalJsonl({ ...input(), cursor: second.cursor })
    expect(third.events).toHaveLength(5)
    expect(third.done).toBe(true)
    expect(
      (await readLocalJsonl({ ...input(), cursor: third.cursor })).events,
    ).toEqual([])
  })
  it('splits large valid records at the storage text budget without skipping a line', async () => {
    const lines = Array.from({ length: 70 }, (_, id) =>
      line({ ...event(String(id)), content: 'x'.repeat(65536) }),
    )
    await fs.writeFile(file, lines.join(''))
    const first = await readLocalJsonl(input())
    expect(first.events).toHaveLength(64)
    expect(
      first.events.reduce((sum, value) => sum + value.text.length, 0),
    ).toBe(4 * 1024 * 1024)
    expect(first.cursor.offset).toBe(
      Buffer.byteLength(lines.slice(0, 64).join('')),
    )
    expect(first.done).toBe(false)
    const second = await readLocalJsonl({ ...input(), cursor: first.cursor })
    expect(second.events).toHaveLength(6)
    expect(second.cursor.offset).toBe(Buffer.byteLength(lines.join('')))
    expect(second.done).toBe(true)
    expect(
      [...first.events, ...second.events].map((value) => value.externalId),
    ).toEqual(Array.from({ length: 70 }, (_, id) => String(id)))
  })
  it('retains an unterminated final line until append completes it', async () => {
    await fs.writeFile(file, line(event()) + JSON.stringify(event('later')))
    const first = await readLocalJsonl(input())
    expect(first.events).toHaveLength(1)
    expect(first.done).toBe(true)
    expect(first.cursor.offset).toBe(Buffer.byteLength(line(event())))
    await fs.appendFile(file, '\n')
    const next = await readLocalJsonl({ ...input(), cursor: first.cursor })
    expect(next.events.map((item) => item.externalId)).toEqual(['later'])
  })
  it('retains incomplete multibyte UTF-8 bytes in the unconfirmed tail', async () => {
    const bytes = Buffer.from(line(event('utf8')))
    const cut = bytes.indexOf(Buffer.from('合')) + 1
    await fs.writeFile(file, bytes.subarray(0, cut))
    const first = await readLocalJsonl(input())
    expect(first.events).toEqual([])
    expect(first.cursor.offset).toBe(0)
    await fs.appendFile(file, bytes.subarray(cut))
    expect(
      (await readLocalJsonl({ ...input(), cursor: first.cursor })).events[0]
        ?.externalId,
    ).toBe('utf8')
  })
  it('supports CRLF and an empty file', async () => {
    expect((await readLocalJsonl(input())).done).toBe(true)
    await fs.writeFile(file, line(event()).replace('\n', '\r\n'))
    expect((await readLocalJsonl(input())).events).toHaveLength(1)
  })
  it('resumes append and rescans truncation or modified prefix for storage deduplication', async () => {
    await fs.writeFile(file, line(event('first')))
    const first = await readLocalJsonl(input())
    await fs.appendFile(file, line(event('second')))
    expect(
      (await readLocalJsonl({ ...input(), cursor: first.cursor })).events.map(
        (value) => value.externalId,
      ),
    ).toEqual(['second'])
    await fs.writeFile(file, line(event('other')))
    expect(
      (await readLocalJsonl({ ...input(), cursor: first.cursor })).events.map(
        (value) => value.externalId,
      ),
    ).toEqual(['other'])
    await fs.writeFile(file, '')
    const empty = await readLocalJsonl({ ...input(), cursor: first.cursor })
    expect(empty.cursor.offset).toBe(0)
  })
  it('rescans rotated files, a different selection or changed source identity', async () => {
    await fs.writeFile(file, line(event()))
    const first = await readLocalJsonl(input())
    await fs.rename(file, path.join(directory, 'old.jsonl'))
    await fs.writeFile(file, line(event()))
    expect(
      (await readLocalJsonl({ ...input(), cursor: first.cursor })).events,
    ).toHaveLength(1)
    expect(
      (
        await readLocalJsonl({
          path: path.join(directory, 'old.jsonl'),
          sourceInstanceId: 'test-source',
          cursor: first.cursor,
        })
      ).events,
    ).toHaveLength(1)
    expect(
      (
        await readLocalJsonl({
          ...input(),
          sourceInstanceId: 'new-source',
          cursor: first.cursor,
        })
      ).events,
    ).toHaveLength(1)
  })
  it.each([
    ['\n', 'INVALID_JSONL'],
    ['{bad}\n', 'INVALID_JSONL'],
    ['[]\n', 'INVALID_JSONL'],
    [line({ ...event(), role: 'admin' }), 'INVALID_SOURCE_EVENT'],
    [line({ ...event(), created_at: 'yesterday' }), 'INVALID_SOURCE_EVENT'],
    [line({ ...event(), revision: 1 }), 'INVALID_SOURCE_EVENT'],
  ])(
    'rejects malformed complete lines without returning partial cursor',
    async (bad, code) => {
      await fs.writeFile(file, line(event()) + bad)
      await expect(readLocalJsonl(input())).rejects.toMatchObject({ code })
    },
  )
  it('rejects invalid UTF-8 in a complete line', async () => {
    await fs.writeFile(file, Buffer.from([0xff, 10]))
    await expect(readLocalJsonl(input())).rejects.toMatchObject({
      code: 'INVALID_UTF8',
    })
  })
  it('enforces file and line limits including oversized unconfirmed tails', async () => {
    await fs.writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1))
    await expect(readLocalJsonl(input())).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    })
    for (const suffix of ['', '\n']) {
      await fs.writeFile(file, 'x'.repeat(128 * 1024 + 1) + suffix)
      await expect(readLocalJsonl(input())).rejects.toMatchObject({
        code: 'LINE_TOO_LARGE',
      })
    }
  })
  it('applies tighter declared limits and record count', async () => {
    await fs.writeFile(file, line(event()) + line(event('two')))
    const manifest = structuredClone(BUILTIN_JSONL_MANIFEST) as any
    manifest.sampling.maxRecordsPerRun = 1
    expect(
      (await readLocalJsonl({ ...input(), manifest })).events,
    ).toHaveLength(1)
    manifest.transport.maxFileBytes = 8
    manifest.transport.maxLineBytes = 8
    await expect(
      readLocalJsonl({ ...input(), manifest }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
  })
  it('evaluates escaped JSON Pointer own properties but rejects prototype traversal', async () => {
    const manifest = structuredClone(BUILTIN_JSONL_MANIFEST) as any
    manifest.mapping.text.pointer = '/payload/a~1b/~0text'
    await fs.writeFile(
      file,
      line({ ...event(), payload: { 'a/b': { '~text': 'escaped' } } }),
    )
    expect(
      (await readLocalJsonl({ ...input(), manifest })).events[0]?.text,
    ).toBe('escaped')
    for (const pointer of [
      '/constructor/name',
      '/__proto__/content',
      '/prototype/content',
      '/toString',
    ]) {
      manifest.mapping.text.pointer = pointer
      await expect(
        readLocalJsonl({ ...input(), manifest }),
      ).rejects.toMatchObject({ code: 'INVALID_SOURCE_EVENT' })
    }
  })
  it('rejects file and ancestor symlinks', async (context) => {
    const alias = path.join(directory, 'alias.jsonl')
    try {
      await fs.symlink(file, alias)
    } catch (error) {
      if (
        process.platform === 'win32' &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      )
        return context.skip()
      throw error
    }
    await expect(
      readLocalJsonl({ ...input(), path: alias }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    const linked = path.join(directory, 'linked')
    await fs.symlink(directory, linked)
    await expect(
      readLocalJsonl({ ...input(), path: path.join(linked, 'events.jsonl') }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
  })
  it('detects a file append during descriptor reading', async () => {
    await fs.writeFile(file, line(event()))
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (String(args[0]) === file) {
        const read = handle.read.bind(handle)
        let appended = false
        handle.read = (async (...readArgs: any[]) => {
          if (!appended) {
            appended = true
            await fs.appendFile(file, line(event('raced')))
          }
          return (read as any)(...readArgs)
        }) as typeof handle.read
      }
      return handle
    })
    await expect(readLocalJsonl(input())).rejects.toMatchObject({
      code: 'FILE_CHANGED',
    })
  })
  it('rejects invalid cursor, manifest, relative paths and missing files with safe codes', async () => {
    await expect(
      readLocalJsonl({ ...input(), cursor: { offset: -1 } as any }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
    await expect(
      readLocalJsonl({ ...input(), manifest: {} }),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
    await expect(
      readLocalJsonl({ ...input(), path: 'events.jsonl' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    await fs.rm(file)
    await expect(readLocalJsonl(input())).rejects.toMatchObject({
      code: 'FILE_UNAVAILABLE',
    })
    try {
      await readLocalJsonl(input())
    } catch (error) {
      expect(error).toBeInstanceOf(LocalJsonlError)
      expect((error as Error).message).not.toContain(directory)
    }
  })
})

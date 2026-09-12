import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
// Windows without Developer Mode denies symlink creation (EPERM); those
// cases can only run where the OS allows symlinks.
const symlinkOrSkip = async (ctx: { skip(): void }, target: string, link: string) => {
  try { await symlink(target, link) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
    throw error
  }
}
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { validateModelDirectory } from '../../apps/desktop/src/main/pet/model-validation'

let root: string
const png = (
  options: { color?: number; interlace?: number; inflatedBytes?: number } = {},
) => {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(type, 4)
    data.copy(result, 8)
    result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2)
  header.writeUInt32BE(2, 4)
  header[8] = 8
  header[9] = options.color ?? 6
  header[12] = options.interlace ?? 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(options.inflatedBytes ?? 18))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const manifest = (extra = {}) => ({
  Version: 3,
  FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'], ...extra },
})
const saveManifest = (value: unknown) =>
  writeFile(path.join(root, 'pet.model3.json'), JSON.stringify(value))
const check = () => validateModelDirectory(root, 'pet.model3.json')
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bugu-model-test-'))
  await saveManifest(manifest())
  await writeFile(path.join(root, 'pet.moc3'), Buffer.from('MOC3\x01\0\0\0'))
  await writeFile(path.join(root, 'pet.png'), png())
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('read-only model preflight', () => {
  it('accepts a manifest and synthetic resources without claiming SDK compatibility', async () => {
    await saveManifest(
      manifest({
        Physics: 'pet.physics3.json',
        Pose: 'pet.pose3.json',
        UserData: 'pet.userdata3.json',
        DisplayInfo: 'pet.cdi3.json',
        Expressions: [{ Name: 'smile', File: 'smile.exp3.json' }],
        Motions: { Idle: [{ File: 'idle.motion3.json' }] },
      }),
    )
    for (const name of [
      'pet.physics3.json',
      'pet.pose3.json',
      'pet.userdata3.json',
      'pet.cdi3.json',
      'smile.exp3.json',
      'idle.motion3.json',
    ])
      await writeFile(path.join(root, name), '{}')
    const result = await check()
    expect(result.ok).toBe(true)
    expect(result.resources).toHaveLength(9)
    expect(
      result.resources.every((resource) => !path.isAbsolute(resource.path)),
    ).toBe(true)
  })
  it('resolves references relative to a nested entry, without scanning unrelated files', async () => {
    await mkdir(path.join(root, 'nested'))
    await writeFile(
      path.join(root, 'nested/pet.model3.json'),
      JSON.stringify(manifest()),
    )
    await writeFile(path.join(root, 'nested/pet.moc3'), 'MOC3\x01\0\0\0')
    await writeFile(path.join(root, 'nested/pet.png'), png())
    await writeFile(path.join(root, 'unrelated.js'), 'throw new Error()')
    expect(
      (await validateModelDirectory(root, 'nested/pet.model3.json')).ok,
    ).toBe(true)
  })
  it.each([
    '../pet.moc3',
    '/tmp/pet.moc3',
    'https://host/pet.moc3',
    'C:\\pet.moc3',
    '%2e%2e/pet.moc3',
    'dir/../pet.moc3',
    'pet.moc3?script=x',
    'pet\0.moc3',
  ])('rejects unsafe reference %s', async (reference) => {
    await saveManifest(manifest({ Moc: reference }))
    expect(
      (await check()).issues.some((issue) => issue.code === 'invalid-path'),
    ).toBe(true)
  })
  it.each(['../pet.model3.json', '/tmp/pet.model3.json', 'pet.cmo3'])(
    'rejects invalid entry %s',
    async (entry) => {
      expect((await validateModelDirectory(root, entry)).issues[0]?.code).toBe(
        'invalid-path',
      )
    },
  )
  it('reports all missing resources and never executes JS or HTML references', async () => {
    await saveManifest(
      manifest({
        Moc: 'missing.moc3',
        Textures: ['missing.png'],
        Motions: { Idle: [{ File: 'code.js' }, { File: 'page.html' }] },
      }),
    )
    const result = await check()
    expect(result.ok).toBe(false)
    expect(
      result.issues.filter((issue) => issue.code === 'missing'),
    ).toHaveLength(2)
    expect(
      result.issues.filter((issue) => issue.code === 'unsupported-resource'),
    ).toHaveLength(2)
  })
  it('rejects symbolic links, including a linked parent directory', async ctx => {
    await symlinkOrSkip(ctx, root, path.join(root, 'linked'))
    await saveManifest(manifest({ Textures: ['linked/pet.png'] }))
    expect(
      (await check()).issues.some((issue) => issue.code === 'symlink'),
    ).toBe(true)
    await symlinkOrSkip(ctx, path.join(root, 'pet.png'), path.join(root, 'link.png'))
    await saveManifest(manifest({ Textures: ['link.png'] }))
    expect(
      (await check()).issues.some((issue) => issue.code === 'symlink'),
    ).toBe(true)
  })
  it('rejects a symlink escaping the selected root', async ctx => {
    await mkdir(path.join(root, 'selected'))
    await writeFile(
      path.join(root, 'selected/pet.model3.json'),
      JSON.stringify(manifest()),
    )
    await symlinkOrSkip(ctx, path.join(root, 'pet.png'), path.join(root, 'selected/pet.png'))
    await symlinkOrSkip(ctx, path.join(root, 'pet.moc3'), path.join(root, 'selected/pet.moc3'))
    const result = await validateModelDirectory(
      path.join(root, 'selected'),
      'pet.model3.json',
    )
    expect(result.ok).toBe(false)
    expect(
      result.issues.filter((issue) => issue.code === 'symlink'),
    ).toHaveLength(2)
  })
  it('rejects a directory pretending to be a resource', async () => {
    await mkdir(path.join(root, 'dir.png'))
    await saveManifest(manifest({ Textures: ['dir.png'] }))
    expect(
      (await check()).issues.some((issue) => issue.code === 'not-file'),
    ).toBe(true)
  })
  it.each([Buffer.from('{'), Buffer.from([0xff, 0xfe]), Buffer.from('null')])(
    'reports invalid manifest JSON or UTF8',
    async (bytes) => {
      await writeFile(path.join(root, 'pet.model3.json'), bytes)
      expect((await check()).issues[0]?.code).toBe('invalid-json')
    },
  )
  it('checks shape and unknown file references', async () => {
    await saveManifest(
      manifest({
        Textures: 'pet.png',
        Script: 'x.js',
        Expressions: [{}],
        Motions: [],
      }),
    )
    const result = await check()
    expect(result.ok).toBe(false)
    expect(
      result.issues.some((issue) => issue.code === 'unsupported-resource'),
    ).toBe(true)
  })
  it('checks JSON resource content and MOC3 magic', async () => {
    await saveManifest(manifest({ Physics: 'pet.physics3.json' }))
    await writeFile(path.join(root, 'pet.physics3.json'), '{broken')
    await writeFile(path.join(root, 'pet.moc3'), '<script>')
    const result = await check()
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-json')
    expect(result.issues.map((issue) => issue.code)).toContain(
      'invalid-resource',
    )
  })
  it('enforces manifest, file count, file and aggregate limits', async () => {
    for (const limits of [
      { manifestBytes: 8 },
      { fileCount: 2 },
      { fileBytes: 8 },
      { totalBytes: 8 },
    ]) {
      expect(
        (
          await validateModelDirectory(root, 'pet.model3.json', limits)
        ).issues.some((issue) => issue.code === 'limit'),
      ).toBe(true)
    }
  })
  it('counts repeated references once for file count and total bytes', async () => {
    await saveManifest(manifest({ Textures: ['pet.png', 'pet.png'] }))
    const result = await validateModelDirectory(root, 'pet.model3.json', {
      fileCount: 3,
    })
    expect(result.ok).toBe(true)
    expect(result.resources).toHaveLength(3)
    expect(result.totalBytes).toBe(
      result.resources.reduce((sum, resource) => sum + resource.bytes, 0),
    )
  })
  it('rejects bad CRC, truncated data, fake PNG and pixel overflow', async () => {
    const badCrc = png()
    badCrc[badCrc.length - 1] = 0
    for (const bytes of [
      badCrc,
      png().subarray(0, 40),
      Buffer.from('<html>'),
    ]) {
      await writeFile(path.join(root, 'pet.png'), bytes)
      expect(
        (await check()).issues.some(
          (issue) => issue.code === 'invalid-resource',
        ),
      ).toBe(true)
    }
    await writeFile(path.join(root, 'pet.png'), png())
    for (const limits of [{ texturePixels: 3 }, { textureDimension: 1 }])
      expect(
        (await validateModelDirectory(root, 'pet.model3.json', limits)).ok,
      ).toBe(false)
  })
  it('rejects unsupported indexed/interlaced PNG and bounded decompression overflow', async () => {
    for (const options of [
      { color: 3 },
      { interlace: 1 },
      { inflatedBytes: 100000 },
    ]) {
      await writeFile(path.join(root, 'pet.png'), png(options))
      const result = await check()
      expect(result.ok).toBe(false)
      expect(
        result.issues.some((issue) => issue.code === 'invalid-resource'),
      ).toBe(true)
    }
  })
  it('does not allow callers to disable capacity limits', async () => {
    await expect(
      validateModelDirectory(root, 'pet.model3.json', { fileBytes: Infinity }),
    ).rejects.toThrow(RangeError)
  })
})

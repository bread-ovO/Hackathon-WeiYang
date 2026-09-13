import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { symlinkOrSkip } from './helpers/symlink-or-skip'
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createRuntimeStore,
  type RuntimePins,
} from '../../apps/desktop/src/main/pet/runtime-store'
import {
  readModelResource,
  type ModelResourceDescriptor,
} from '../../apps/desktop/src/main/pet/model-route'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
let root: string, source: string, privateRoot: string, pins: RuntimePins
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pet-runtime-')))
  source = join(root, 'source')
  privateRoot = join(root, 'private')
  await mkdir(source)
  const paths = [
    'core.js',
    'framework.js',
    'shaders/test.vert',
    'shaders/test.frag',
    'licenses/core.md',
  ]
  pins = {
    version: 'v1',
    files: paths.map((path) => ({
      path,
      source: `original/${path}`,
      bytes: Buffer.byteLength(path),
      sha256: digest(path),
    })),
  }
  for (const pin of pins.files) {
    await mkdir(dirname(join(source, pin.path)), { recursive: true })
    await writeFile(join(source, pin.path), pin.path)
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
it('installs exact pins, survives a new store instance and serves only runtime allowlist', async () => {
  const store = createRuntimeStore(privateRoot, pins)
  expect(await store.status()).toBe(false)
  await store.install(source)
  expect(await createRuntimeStore(privateRoot, pins).status()).toBe(true)
  const response = await store.read('core.js')
  expect(response?.mime).toBe('text/javascript')
  expect(Buffer.from(response!.bytes).toString()).toBe('core.js')
  expect(await store.read('licenses/core.md')).toBeNull()
  expect(await store.read('unknown.js')).toBeNull()
  expect(await store.read('../core.js')).toBeNull()
  expect((await store.read('shaders/test.vert'))?.mime).toBe('text/plain')
  response!.bytes.fill(0)
  expect(Buffer.from((await store.read('core.js'))!.bytes).toString()).toBe(
    'core.js',
  )
})
it('rejects a modified source and does not publish a partial runtime', async () => {
  await writeFile(join(source, pins.files[1]!.path), 'forged')
  const store = createRuntimeStore(privateRoot, pins)
  await expect(store.install(source)).rejects.toThrow('PET_RUNTIME_INVALID')
  expect(await store.status()).toBe(false)
  expect(await store.read('core.js')).toBeNull()
})
it('ignores any user-supplied manifest and rejects changed installed bytes', async () => {
  await writeFile(
    join(source, 'runtime-assets.json'),
    JSON.stringify({ files: [] }),
  )
  const store = createRuntimeStore(privateRoot, pins)
  await store.install(source)
  await writeFile(join(privateRoot, 'v1', 'core.js'), 'core.Xs')
  expect(await store.status()).toBe(false)
  expect(await store.read('core.js')).toBeNull()
  await store.install(source)
  expect(await store.status()).toBe(true)
})
it('rejects source and installed symlinks, including ancestor links', async (ctx) => {
  const original = join(source, pins.files[0]!.path)
  await rm(original)
  await symlinkOrSkip(ctx, join(source, pins.files[1]!.path), original)
  const store = createRuntimeStore(privateRoot, pins)
  await expect(store.install(source)).rejects.toThrow('PET_RUNTIME_INVALID')
  await rm(original)
  await writeFile(original, 'core.js')
  await store.install(source)
  await rm(join(privateRoot, 'v1', 'core.js'))
  await symlinkOrSkip(ctx, original, join(privateRoot, 'v1', 'core.js'))
  expect(await store.read('core.js')).toBeNull()
  expect(await store.status()).toBe(false)
  const linked = join(root, 'linked')
  await symlinkOrSkip(ctx, privateRoot, linked)
  expect(await createRuntimeStore(linked, pins).status()).toBe(false)
})
it('serializes concurrent installs and snapshots trusted pins', async () => {
  const store = createRuntimeStore(privateRoot, pins)
  pins.files[0]!.sha256 = '0'.repeat(64)
  await Promise.all([store.install(source), store.install(source)])
  expect(await store.status()).toBe(true)
})
it('rejects unbounded trusted fixture declarations', () => {
  expect(() =>
    createRuntimeStore(privateRoot, {
      version: '../escape',
      files: pins.files,
    }),
  ).toThrow('PET_RUNTIME_INVALID')
  expect(() =>
    createRuntimeStore(privateRoot, {
      ...pins,
      files: [{ ...pins.files[0]!, bytes: 33 * 1024 * 1024 }],
    }),
  ).toThrow('PET_RUNTIME_INVALID')
})
async function modelFixture() {
  const id = 'a'.repeat(64),
    directory = join(root, id)
  await mkdir(directory)
  const files = {
    'm.model3.json': '{}',
    'body.moc3': 'MOC3',
    'texture.png': 'PNG',
    'voice.wav': 'WAVE',
    'evil.js': 'alert(1)',
    'evil.svg': '<svg/>',
    'evil.html': '<html/>',
  }
  const descriptor: ModelResourceDescriptor = {
    id,
    entry: 'm.model3.json',
    resources: Object.entries(files).map(([path, text]) => ({
      path,
      bytes: Buffer.byteLength(text),
      sha256: digest(text),
      kind: 'fixture',
    })),
  }
  for (const [path, text] of Object.entries(files))
    await writeFile(join(directory, path), text)
  return { descriptor, directory }
}
it('serves exact model resource descriptors and refuses executable content even when listed', async () => {
  const { descriptor } = await modelFixture()
  expect(
    (await readModelResource(root, descriptor, 'm.model3.json'))?.mime,
  ).toBe('application/json')
  expect((await readModelResource(root, descriptor, 'texture.png'))?.mime).toBe(
    'image/png',
  )
  expect((await readModelResource(root, descriptor, 'voice.wav'))?.mime).toBe(
    'audio/wav',
  )
  for (const path of [
    'evil.js',
    'evil.svg',
    'evil.html',
    'missing.png',
    '../private',
    '%2e%2e/file',
  ])
    expect(await readModelResource(root, descriptor, path)).toBeNull()
})
it('rejects corrupted, truncated, duplicate or linked model resources', async (ctx) => {
  const { descriptor, directory } = await modelFixture()
  await writeFile(join(directory, 'texture.png'), 'BAD')
  expect(await readModelResource(root, descriptor, 'texture.png')).toBeNull()
  await writeFile(join(directory, 'body.moc3'), 'MOC')
  expect(await readModelResource(root, descriptor, 'body.moc3')).toBeNull()
  expect(
    await readModelResource(
      root,
      {
        ...descriptor,
        resources: [...descriptor.resources, descriptor.resources[0]!],
      },
      'm.model3.json',
    ),
  ).toBeNull()
  await rm(join(directory, 'm.model3.json'))
  await symlinkOrSkip(ctx, join(directory, 'evil.js'), join(directory, 'm.model3.json'))
  expect(await readModelResource(root, descriptor, 'm.model3.json')).toBeNull()
  expect(await readFile(join(directory, 'evil.js'), 'utf8')).toBe('alert(1)')
})

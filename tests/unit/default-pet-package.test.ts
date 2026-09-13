import { afterEach, expect, it } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  access,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { bundleDefaultPet } from '../../scripts/bundle-default-pet.mjs'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bugu-default-package-'))
  roots.push(root)
  const files = [
    {
      path: 'Hiyori/Hiyori.model3.json',
      source: 'Samples/Resources/Hiyori/Hiyori.model3.json',
      text: '{}',
    },
    { path: 'LICENSE.md', source: 'LICENSE.md', text: 'sample license' },
  ]
  const pins = files.map(({ text, ...file }) => ({
    ...file,
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  }))
  for (const file of files) {
    const path = join(root, '.pet-sdk/CubismSdkForWeb-5-r.5', file.source)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.text)
  }
  const config = join(root, 'apps/desktop/src/main/pet')
  await mkdir(config, { recursive: true })
  await writeFile(
    join(config, 'default-model-assets.json'),
    JSON.stringify({ files: pins }),
  )
  await writeFile(
    join(config, 'runtime-assets.json'),
    JSON.stringify({
      files: [
        {
          path: 'core.js',
          bytes: 2,
          sha256: createHash('sha256').update('ok').digest('hex'),
        },
      ],
    }),
  )
  await mkdir(join(root, '.pet-sdk/runtime'), { recursive: true })
  await writeFile(join(root, '.pet-sdk/runtime/core.js'), 'ok')
  const target = join(root, 'apps/desktop/out/bundled-pet')
  await mkdir(join(target, 'Haru'), { recursive: true })
  await writeFile(join(target, 'Haru/old.json'), '{}')
  return { root, target }
}
it('replaces stale Haru with exactly pinned Hiyori resources and attribution', async () => {
  const { root, target } = await fixture()
  await bundleDefaultPet(root)
  expect(
    JSON.parse(await readFile(join(target, 'demo.json'), 'utf8')),
  ).toMatchObject({ entry: 'Hiyori.model3.json' })
  expect(await readFile(join(target, 'runtime/core.js'), 'utf8')).toBe('ok')
  await expect(access(join(target, 'Haru'))).rejects.toThrow()
  expect(await readFile(join(target, 'LICENSE.md'), 'utf8')).toBe(
    'sample license',
  )
})
it.each(['missing-model', 'changed-runtime'])(
  'fails packaging and removes stale/partial assets for %s',
  async (mode) => {
    const { root, target } = await fixture()
    if (mode === 'missing-model')
      await rm(
        join(
          root,
          '.pet-sdk/CubismSdkForWeb-5-r.5/Samples/Resources/Hiyori/Hiyori.model3.json',
        ),
      )
    else await writeFile(join(root, '.pet-sdk/runtime/core.js'), 'no')
    await expect(bundleDefaultPet(root)).rejects.toThrow(
      'packaging without Hiyori is not supported',
    )
    await expect(access(target)).rejects.toThrow()
  },
)

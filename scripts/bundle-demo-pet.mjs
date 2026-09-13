import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

// Local demo only. Standard package:dir deliberately excludes third-party sample assets.
const repo = resolve(import.meta.dirname, '..')
const sdk = join(repo, '.pet-sdk/CubismSdkForWeb-5-r.5')
const target = join(repo, 'apps/desktop/out/bundled-pet')
const pins = JSON.parse(
  await readFile(
    join(repo, 'apps/desktop/src/main/pet/runtime-assets.json'),
    'utf8',
  ),
)
for (const file of pins.files) {
  const bytes = await readFile(join(repo, '.pet-sdk/runtime', file.path))
  if (
    bytes.length !== file.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== file.sha256
  )
    throw new Error(
      'Demo runtime does not match pins; run scripts/fetch-pet-sdk.mjs first.',
    )
}
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(join(repo, '.pet-sdk/runtime'), join(target, 'runtime'), {
  recursive: true,
})
await cp(join(sdk, 'Samples/Resources/Haru'), join(target, 'Haru'), {
  recursive: true,
})
await cp(join(sdk, 'LICENSE.md'), join(target, 'LICENSE.md'))
await cp(join(sdk, 'NOTICE.md'), join(target, 'NOTICE.md'))
await writeFile(
  join(target, 'demo.json'),
  JSON.stringify({
    version: 1,
    entry: 'Haru.model3.json',
    attribution:
      'Haru © Live2D Inc. — local demo sample, not BUGU original character',
  }),
)
console.log(
  'Bundled Haru and pinned runtime for the local demonstration build only.',
)

import { mkdir, rm, readFile, writeFile, lstat } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

const repo = resolve(import.meta.dirname, '..')
const fingerprint = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function assets(root) {
  const model = JSON.parse(
    await readFile(
      join(root, 'apps/desktop/src/main/pet/default-model-assets.json'),
      'utf8',
    ),
  )
  const runtime = JSON.parse(
    await readFile(
      join(root, 'apps/desktop/src/main/pet/runtime-assets.json'),
      'utf8',
    ),
  )
  return [
    ...model.files.map((file) => ({
      ...file,
      source: join(root, '.pet-sdk/CubismSdkForWeb-5-r.5', file.source),
    })),
    ...runtime.files.map((file) => ({
      ...file,
      path: `runtime/${file.path}`,
      source: join(root, '.pet-sdk/runtime', file.path),
    })),
  ]
}

/** Build inputs are pinned; only listed resources are copied, never arbitrary SDK files. */
export async function bundleDefaultPet(root = repo) {
  const target = join(root, 'apps/desktop/out/bundled-pet')
  await rm(target, { recursive: true, force: true })
  try {
    const files = await assets(root)
    // Validate everything before publishing the manifest used by first-run initialization.
    const checked = await Promise.all(
      files.map(async (file) => {
        const stat = await lstat(file.source)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes)
          throw Error('INVALID_DEFAULT_ASSET')
        const bytes = await readFile(file.source)
        if (fingerprint(bytes) !== file.sha256)
          throw Error('INVALID_DEFAULT_ASSET')
        return { path: file.path, bytes }
      }),
    )
    for (const file of checked) {
      const path = join(target, file.path)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.bytes)
    }
    await writeFile(
      join(target, 'demo.json'),
      JSON.stringify({
        version: 1,
        entry: 'Hiyori.model3.json',
        attribution:
          'Hiyori (桃濑日和) © Live2D Inc. — official sample character',
      }),
    )
  } catch {
    await rm(target, { recursive: true, force: true })
    throw Error(
      'Hiyori/model runtime missing or changed. Run node scripts/fetch-pet-sdk.mjs before packaging; packaging without Hiyori is not supported.',
    )
  }
}

/** electron-builder beforePack: applies to directory, DMG, real and demo packages alike. */
export default async function beforePack() {
  await bundleDefaultPet()
}

/** electron-builder afterPack: check actual unpacked payload, not just build inputs. */
export async function verifyPackagedPet(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents/Resources',
        )
      : join(context.appOutDir, 'resources')
  const target = join(resources, 'app.asar.unpacked/out/bundled-pet')
  const manifest = JSON.parse(await readFile(join(target, 'demo.json'), 'utf8'))
  if (manifest.entry !== 'Hiyori.model3.json')
    throw Error('PACKAGED_HIYORI_MISSING')
  for (const file of await assets(repo)) {
    const bytes = await readFile(join(target, file.path))
    if (bytes.length !== file.bytes || fingerprint(bytes) !== file.sha256)
      throw Error('PACKAGED_HIYORI_INVALID')
  }
  try {
    await lstat(join(target, 'Haru'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw Error('PACKAGED_LEGACY_HARU')
}

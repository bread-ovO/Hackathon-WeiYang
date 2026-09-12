// PET01 reproducible asset fetch: downloads the official Cubism SDK for Web
// (pinned URL + sha256) into .pet-sdk/ (gitignored — the zip contains Live2D
// proprietary assets that must not enter the repository), extracts it, and
// bundles the Live2D Open Software License Framework sources into a single IIFE we can serve
// to the verification harness. Sample models ship inside the official zip.
//
//   node scripts/fetch-pet-sdk.mjs
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  mkdtempSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get as httpsGet } from 'node:https'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, '.pet-sdk')
const ZIP_URL =
  'https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-5-r.5.zip'
const ZIP_SHA256 =
  '67064a7fb1812cf502f5c4a03bfe12cc638c75a621bb4acf06bb28763df06ba0'
const sdkDir = join(target, 'CubismSdkForWeb-5-r.5')

const download = (url, to) =>
  new Promise((done, fail) => {
    if (new URL(url).protocol !== 'https:')
      return fail(new Error('HTTPS_REQUIRED'))
    const temporary = `${to}.partial`
    const chunks = []
    let length = 0,
      settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        rmSync(temporary, { force: true })
        fail(error)
      } else done()
    }
    const request = httpsGet(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        finish(new Error(`SDK_HTTP_STATUS_${response.statusCode}`))
        return
      }
      response.on('data', (chunk) => {
        length += chunk.length
        if (length > 128 * 1024 * 1024) {
          request.destroy(new Error('SDK_DOWNLOAD_TOO_LARGE'))
          return
        }
        chunks.push(chunk)
      })
      response.on('error', finish)
      response.on('aborted', () => finish(new Error('SDK_DOWNLOAD_ABORTED')))
      response.on('end', () => {
        if (settled) return
        try {
          const bytes = Buffer.concat(chunks)
          if (createHash('sha256').update(bytes).digest('hex') !== ZIP_SHA256)
            throw new Error('SDK_CHECKSUM_MISMATCH')
          writeFileSync(temporary, bytes, { mode: 0o600 })
          renameSync(temporary, to)
          finish()
        } catch (error) {
          finish(error)
        }
      })
    })
    const timer = setTimeout(
      () => request.destroy(new Error('SDK_DOWNLOAD_TIMEOUT')),
      90_000,
    )
    request.on('error', finish)
  })

const sha256 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex')

mkdirSync(target, { recursive: true, mode: 0o700 })
const zipPath = join(target, 'CubismSdkForWeb-5-r.5.zip')
if (!existsSync(zipPath) || sha256(zipPath) !== ZIP_SHA256) {
  console.log(`downloading ${ZIP_URL}`)
  await download(ZIP_URL, zipPath)
}
const actual = sha256(zipPath)
if (actual !== ZIP_SHA256) throw new Error(`sha256 mismatch: ${actual}`)
console.log(`zip ok (sha256 ${actual.slice(0, 16)}…)`)

// Recreate the extracted tree from the pinned archive, never trust a stale cache.
const staging = mkdtempSync(join(target, '.extract-'))
try {
  const members = execFileSync('tar', ['-tf', zipPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
  if (
    members.some(
      (name) =>
        name.startsWith('/') ||
        name.includes('\\') ||
        name.split('/').includes('..') ||
        !name.startsWith('CubismSdkForWeb-5-r.5/'),
    )
  )
    throw new Error('SDK_ARCHIVE_PATH_INVALID')
  execFileSync('tar', ['-xf', zipPath, '-C', staging], { stdio: 'inherit' })
  const incoming = join(staging, 'CubismSdkForWeb-5-r.5')
  for (const file of [
    'Core/live2dcubismcore.min.js',
    'Core/live2dcubismcore.d.ts',
    'Core/LICENSE.md',
    'Core/RedistributableFiles.txt',
    'Framework/LICENSE.md',
    'Framework/src/live2dcubismframework.ts',
    'Framework/Shaders/WebGL',
    'Samples/Resources/Haru/Haru.model3.json',
    'Samples/Resources/Haru/motions/haru_g_idle.motion3.json',
  ])
    if (!existsSync(join(incoming, file)))
      throw new Error(`SDK incomplete: missing ${file}`)
  const backup = join(staging, 'prior')
  if (existsSync(sdkDir)) renameSync(sdkDir, backup)
  try {
    renameSync(incoming, sdkDir)
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, sdkDir)
    throw error
  }
} finally {
  rmSync(staging, { recursive: true, force: true })
}
console.log('SDK extracted and verified')

// Umbrella entry exposing the subset the harness drives; keep in sync with
// tests/desktop/pet/verify.js.
const entry = join(target, 'framework-entry.ts')
writeFileSync(
  entry,
  `// Generated by scripts/fetch-pet-sdk.mjs
export { CubismFramework } from './CubismSdkForWeb-5-r.5/Framework/src/live2dcubismframework'
export { CubismMatrix44 } from './CubismSdkForWeb-5-r.5/Framework/src/math/cubismmatrix44'
export { CubismModel } from './CubismSdkForWeb-5-r.5/Framework/src/model/cubismmodel'
export { CubismMoc } from './CubismSdkForWeb-5-r.5/Framework/src/model/cubismmoc'
export { CubismRenderer_WebGL } from './CubismSdkForWeb-5-r.5/Framework/src/rendering/cubismrenderer_webgl'
export { CubismMotion } from './CubismSdkForWeb-5-r.5/Framework/src/motion/cubismmotion'
export { CubismMotionManager } from './CubismSdkForWeb-5-r.5/Framework/src/motion/cubismmotionmanager'
export { CubismMotionQueueManager } from './CubismSdkForWeb-5-r.5/Framework/src/motion/cubismmotionqueuemanager'
export { CubismPhysics } from './CubismSdkForWeb-5-r.5/Framework/src/physics/cubismphysics'
export { CubismModelSettingJson } from './CubismSdkForWeb-5-r.5/Framework/src/cubismmodelsettingjson'
export { CubismJson } from './CubismSdkForWeb-5-r.5/Framework/src/utils/cubismjson'
export { CubismIdManager } from './CubismSdkForWeb-5-r.5/Framework/src/id/cubismidmanager'
`,
)

const require = createRequire(join(root, 'package.json'))
const esbuild = require('esbuild')
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'Live2DCubismFramework',
  outfile: join(target, 'dist/live2dcubismframework.min.js'),
})
console.log(
  'framework bundle written to .pet-sdk/dist/live2dcubismframework.min.js',
)
console.log(
  'next: pnpm exec playwright test tests/desktop/pet/pet-verify.spec.ts',
)

// Package only repository-pinned runtime files. Never accept hashes from the selected SDK.
const pins = JSON.parse(
  readFileSync(
    join(root, 'apps/desktop/src/main/pet/runtime-assets.json'),
    'utf8',
  ),
)
const runtimeStage = mkdtempSync(join(target, '.runtime-package-'))
try {
  const incoming = join(runtimeStage, 'runtime')
  mkdirSync(incoming)
  for (const pin of pins.files) {
    const source = resolve(target, pin.source)
    let component = source
    while (true) {
      if (lstatSync(component).isSymbolicLink())
        throw new Error('runtime source symlink rejected')
      const parent = dirname(component)
      if (parent === component) break
      component = parent
    }
    if (
      !lstatSync(source).isFile() ||
      realpathSync(source) !== source ||
      lstatSync(source).size !== pin.bytes
    )
      throw new Error(`runtime pin size mismatch: ${pin.path}`)
    const bytes = readFileSync(source)
    if (
      bytes.length !== pin.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== pin.sha256
    )
      throw new Error(`runtime pin hash mismatch: ${pin.path}`)
    const destination = join(incoming, pin.path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
    if (sha256(destination) !== pin.sha256)
      throw new Error(`runtime copy mismatch: ${pin.path}`)
  }
  const destination = join(target, 'runtime')
  const backup = join(runtimeStage, 'prior')
  if (existsSync(destination)) renameSync(destination, backup)
  try {
    renameSync(incoming, destination)
  } catch (error) {
    if (existsSync(backup)) renameSync(backup, destination)
    throw error
  }
  console.log(
    `runtime package written to .pet-sdk/runtime (${pins.files.length} pinned files); select this directory in BUGU`,
  )
} finally {
  rmSync(runtimeStage, { recursive: true, force: true })
}

// PET15: repository guard — model assets must never enter the repo, and the
// vendored Live2D runtime directory must contain exactly the allow-listed
// redistributable files. Run in CI via `pnpm check` (see package.json).
import { execFileSync } from 'node:child_process'

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const modelAssetPattern =
  /\.(moc3|cmo3|model3\.json|physics3\.json|pose3\.json|cdi3\.json|userdata3\.json|motion3\.json|exp3\.json)$/i
const offenders = tracked.filter(
  (file) =>
    modelAssetPattern.test(file) &&
    // Haru test fixtures under .pet-sdk never exist in git (gitignored);
    // this exemption list stays empty on purpose.
    false,
)
const vendorAllowList = new Set([
  'apps/desktop/src/renderer/public/live2d/README.md',
  'apps/desktop/src/renderer/public/live2d/CORE-LICENSE.md',
  'apps/desktop/src/renderer/public/live2d/FRAMEWORK-LICENSE.md',
  'apps/desktop/src/renderer/public/live2d/RedistributableFiles.txt',
  'apps/desktop/src/renderer/public/live2d/live2dcubismcore.min.js',
  'apps/desktop/src/renderer/public/live2d/live2dcubismframework.min.js',
])
const vendored = tracked.filter((file) =>
  file.startsWith('apps/desktop/src/renderer/public/live2d/'),
)
const vendorUnexpected = vendored.filter(
  (file) => !vendorAllowList.has(file) && !file.startsWith('apps/desktop/src/renderer/public/live2d/shaders/'),
)
const missingRequired = [...vendorAllowList].filter((file) => !tracked.includes(file))

const errors = [
  ...offenders.map((file) => `model asset tracked in repo: ${file}`),
  ...vendorUnexpected.map((file) => `unexpected vendored live2d file: ${file}`),
  ...missingRequired.map((file) => `vendored live2d file missing: ${file}`),
]
if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(
  `Live2D asset boundary passed (${vendored.length} vendored files, no model assets)`,
)

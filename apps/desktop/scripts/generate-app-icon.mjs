// Rebuild every application icon from the approved BUGU bird-girl artwork.
// Uses the project's Electron nativeImage encoder; no additional dependency.
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../package.json', import.meta.url))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [fileURLToPath(new URL('./render-brand-icons.cjs', import.meta.url))], { env, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)

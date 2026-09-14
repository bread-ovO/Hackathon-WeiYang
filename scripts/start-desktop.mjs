import { spawnSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { bundleDefaultPet } from './bundle-default-pet.mjs'
const root = resolve(import.meta.dirname, '..')
const mode = process.argv[2]
if (!['--mode=demo', '--mode=real'].includes(mode)) {
  throw new Error('Use --mode=demo or --mode=real')
}
const built = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['--yes', 'pnpm@10.34.5', 'build'],
  { cwd: root, stdio: 'inherit' },
)
if (built.status !== 0) process.exit(built.status ?? 1)
await bundleDefaultPet()
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
delete env.MEMO_TEST_USER_DATA
const child = spawn(
  require('electron'),
  [resolve(root, 'apps/desktop'), mode],
  {
    cwd: root,
    env,
    stdio: 'inherit',
  },
)
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})

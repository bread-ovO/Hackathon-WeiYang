import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const desktop = resolve(import.meta.dirname, '../apps/desktop')
const require = createRequire(resolve(desktop, 'package.json'))
const cli = resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
const result = spawnSync(process.execPath, [cli, 'build'], {
  cwd: desktop,
  env: { ...process.env, VITE_MEMO_NO_DEMO: '1' },
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1

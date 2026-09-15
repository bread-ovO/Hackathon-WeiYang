import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const require = createRequire(resolve('apps/desktop/package.json'))
const dir = await mkdtemp(join(tmpdir(), 'bugu-eval-runner-'))
try {
  const entry = join(dir, 'evaluate.cjs')
  await build({
    entryPoints: ['tests/evals/run-extraction.ts'],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    tsconfig: 'tsconfig.json',
  })
  const child = spawn(require('electron'), [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: resolve('apps/desktop/node_modules'),
    },
  })
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })
} finally {
  await rm(dir, { recursive: true, force: true })
}

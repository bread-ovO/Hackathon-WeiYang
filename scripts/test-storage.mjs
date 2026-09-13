import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const require = createRequire(resolve('apps/desktop/package.json'))
const entries = [
  ['tests/storage-integration.ts', 'storage-test'],
  ['tests/data-foundation/integration.ts', 'data-test'],
  ['tests/data-foundation/crash-worker.ts', 'data-crash'],
  ['tests/data-foundation/race-worker.ts', 'data-race'],
]
await Promise.all(
  entries.map(([entry, name]) =>
    build({
      entryPoints: [entry],
      outfile: `apps/desktop/out/${name}.cjs`,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['better-sqlite3'],
      tsconfig: 'tsconfig.json',
    }),
  ),
)
for (const name of ['storage-test', 'data-test']) {
  const result = spawnSync(
    require('electron'),
    [`apps/desktop/out/${name}.cjs`],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'inherit',
      timeout: 180000,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

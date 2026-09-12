import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const require = createRequire(resolve('apps/desktop/package.json'))
for (const name of ['storage-integration', 'job-queue-integration', 'search-integration', 'task-model-integration', 'source-import-integration', 'export-integration', 'plugin-install-integration']) {
  const output = `apps/desktop/out/${name}.cjs`
  await build({
    entryPoints: [`tests/${name}.ts`],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    tsconfig: 'tsconfig.json',
  })
  const result = spawnSync(require('electron'), [output], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

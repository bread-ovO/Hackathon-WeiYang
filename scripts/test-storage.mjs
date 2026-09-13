import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const require = createRequire(resolve('apps/desktop/package.json'))
for (const name of ['storage-integration', 'event-context-integration', 'processing-integration', 'ingestion-budget-integration', 'job-queue-integration', 'search-integration', 'task-model-integration', 'source-import-integration', 'export-integration', 'retraction-export-integration', 'reference-review-export-integration', 'retraction-integration', 'revision-review-integration', 'plugin-install-integration', 'github-integration', 'feishu-integration', 'reference-audit-integration', 'timeline-integration', 'event-metadata-integration', 'plan-changes-integration', 'plan-change-timeline-integration', 'plan-change-export-integration', 'source-associations-integration', 'source-association-audit-integration', 'plan-associations-integration']) {
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

const entries = [
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
for (const name of ['data-test']) {
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

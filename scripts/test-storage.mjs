import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const require = createRequire(resolve('apps/desktop/package.json'))
const selected = process.argv.slice(2)
const names = [
  'task-analysis-integration',
  'task-chat-integration',
  'delivery-integration',
  'five-requirements-integration',
  'storage-integration',
  'event-context-integration',
  'processing-integration',
  'ingestion-budget-integration',
  'job-queue-integration',
  'search-integration',
  'task-model-integration', 'task-structure-integration',
  'source-import-integration',
  'export-integration',
  'retraction-export-integration',
  'reference-review-export-integration',
  'retraction-integration',
  'revision-review-integration',
  'plugin-install-integration',
  'github-integration',
  'feishu-integration',
  'reference-audit-integration',
  'timeline-integration',
  'event-metadata-integration',
  'plan-changes-integration',
  'plan-change-timeline-integration',
  'plan-change-export-integration',
  'source-associations-integration',
  'source-association-audit-integration',
  'plan-associations-integration',
  'pet-context-integration',
]
if (selected.some((n) => !names.includes(n)))
  throw Error('Unknown storage test name')
for (const name of selected.length ? selected : names) {
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

// Explicit, opt-in network probe: public metadata only; no credentials, downloads or DB writes.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
const output = resolve('apps/desktop/out/probe-http-source.cjs')
await build({
  stdin: {
    contents: `import {createHttpJsonReader} from './packages/plugin-host/src/http-json';
import manifest from './examples/sources/github-release-assets.json';
(async()=>{
  const reader=createHttpJsonReader({manifest,authorization:{sourceInstanceId:'public-release-probe',domain:'api.github.com'}});
  const batch=await reader.read();
  if(!batch.done||batch.events.length===0)throw new Error('PROBE_INCOMPLETE');
  console.log(JSON.stringify({source:'public-github-release-assets',events:batch.events.length,pagesRead:batch.pagesRead,done:batch.done,roles:[...new Set(batch.events.map(e=>e.role))],databaseWrites:false}));
})().catch(e=>{console.error(e instanceof Error ? e.name+': '+e.message : 'PROBE_FAILED');process.exitCode=1});`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  tsconfig: 'tsconfig.json',
})
const result = spawnSync(process.execPath, [output], {
  stdio: 'inherit',
  timeout: 30000,
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1

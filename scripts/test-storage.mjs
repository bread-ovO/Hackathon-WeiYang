import {build} from 'esbuild'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {resolve} from 'node:path'
const require=createRequire(resolve('apps/desktop/package.json'))
await build({entryPoints:['tests/storage-integration.ts'],outfile:'apps/desktop/out/storage-test.cjs',bundle:true,platform:'node',format:'cjs',external:['better-sqlite3'],tsconfig:'tsconfig.json'})
const result=spawnSync(require('electron'),['apps/desktop/out/storage-test.cjs'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:'inherit'})
if(result.error)throw result.error
process.exit(result.status??1)

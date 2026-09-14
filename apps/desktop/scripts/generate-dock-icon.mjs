// SVG defines the icon shape; the approved mascot remains embedded raster artwork.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = new URL('../', import.meta.url)
const art = readFileSync(new URL('../../assets/brand/bugu-birdgirl-v1/bugu-icon.png', root)).toString('base64')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="184"/></clipPath></defs>
  <image x="100" y="100" width="824" height="824" clip-path="url(#tile)" xlink:href="data:image/png;base64,${art}"/>
</svg>\n`
writeFileSync(new URL('../../assets/brand/bugu-birdgirl-v1/bugu-dock.svg', root), svg)
const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [fileURLToPath(new URL('./render-dock-icon.cjs', import.meta.url))], { env, stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) throw new Error('Dock icon generation failed')

// Rasterize the SVG tile geometry using the existing Electron image encoder.
const { app, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const root = resolve(__dirname, '..')
app.whenReady().then(() => {
  const svg = readFileSync(resolve(root, '../../assets/brand/bugu-birdgirl-v1/bugu-dock.svg'), 'utf8')
  const match = svg.match(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)"/)
  if (!match) throw new Error('Missing SVG rounded tile')
  const [left, top, width, height, radius] = match.slice(1).map(Number)
  const source = nativeImage.createFromPath(resolve(root, '../../assets/brand/bugu-birdgirl-v1/bugu-icon.png')).resize({ width, height, quality: 'best' }).toBitmap()
  const out = Buffer.alloc(1024 * 1024 * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // Signed distance to the rounded rectangle; 1-pixel antialias coverage.
    const dx = Math.max(Math.abs(x + .5 - width / 2) - (width / 2 - radius), 0)
    const dy = Math.max(Math.abs(y + .5 - height / 2) - (height / 2 - radius), 0)
    const coverage = Math.max(0, Math.min(1, radius + .5 - Math.hypot(dx, dy)))
    const from = (y * width + x) * 4
    const to = ((y + top) * 1024 + x + left) * 4
    source.copy(out, to, from, from + 4)
    out[to + 3] = Math.round(source[from + 3] * coverage)
  }
  const icon = nativeImage.createFromBitmap(out, { width: 1024, height: 1024 })
  writeFileSync(resolve(root, 'build/icon-mac.png'), icon.toPNG())
  writeFileSync(resolve(root, 'src/renderer/public/dock-icon.png'), icon.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
  console.log('Generated transparent rounded macOS icons from SVG tile geometry.')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

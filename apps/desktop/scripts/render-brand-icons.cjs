const { app, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const root = resolve(__dirname, '..')
app.whenReady().then(() => {
  const image = nativeImage.createFromBuffer(readFileSync(resolve(root, '../../assets/brand/bugu-birdgirl-v1/bugu-icon.png')))
  if (image.isEmpty()) throw new Error('Missing or invalid approved BUGU artwork')
  const png = size => image.resize({ width: size, height: size, quality: 'best' }).toPNG()
  writeFileSync(resolve(root, 'build/icon.png'), png(1024))
  writeFileSync(resolve(root, 'src/renderer/public/icon.png'), png(256))
  const sizes = [16, 32, 48, 64, 128, 256]
  const images = sizes.map(png)
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, index) => {
    const at = 6 + index * 16
    header[at] = header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(images[index].length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += images[index].length
  })
  writeFileSync(resolve(root, 'build/icon.ico'), Buffer.concat([header, ...images]))
  writeFileSync(resolve(root, 'src/main/tray-icon.ts'), '// Generated from the approved BUGU bird-girl artwork by generate-app-icon.mjs.\n' + `export const TRAY_ICON_DATA_URL = 'data:image/png;base64,${png(32).toString('base64')}'\n`)
  console.log('Generated PNG, multi-size ICO and tray icon from BUGU bird-girl artwork.')
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })

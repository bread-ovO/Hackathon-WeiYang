// Rasterizes the app's CSS brand mark (sidebar `brand-mark`: three vertical
// bars skewed -13deg, middle bar in the Kumo brand color) into the icon set
// used by the window/taskbar and electron-builder. Pure Node, no deps:
//   node apps/desktop/scripts/generate-app-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const brand = [246, 130, 31] // --text-color-kumo-brand #f6821f
const ink = [59, 36, 23] // --text-color-kumo-default (dark brown ink)

/** Renders the brand mark centered on a transparent S×S canvas.
 * Same geometry as .brand-mark (three bars, -13deg skew, brand-colored
 * middle), re-proportioned to stay legible at 16–32px taskbar sizes. */
function render(S) {
  const px = new Uint8Array(S * S * 4)
  const k = S / 512
  const boxW = 320 * k
  const boxH = 340 * k
  const barW = 70 * k
  const gap = 18 * k
  const cx = S / 2
  const cy = S / 2
  const skew = Math.tan((-13 * Math.PI) / 180)
  const bars = [
    { h: 240 * k, color: ink },
    { h: 340 * k, color: brand },
    { h: 240 * k, color: ink },
  ]
  let x = cx - boxW / 2
  for (const bar of bars) {
    const top = cy - bar.h / 2
    for (let py = 0; py < S; py++) {
      if (py < top || py >= top + bar.h) continue
      // Slanted bar: the accepted x window shifts with the scanline.
      const shift = skew * (py - cy)
      for (let pxi = 0; pxi < S; pxi++) {
        const lx = pxi + shift
        if (lx < x || lx >= x + barW) continue
        const i = (py * S + pxi) * 4
        px[i] = bar.color[0]
        px[i + 1] = bar.color[1]
        px[i + 2] = bar.color[2]
        px[i + 3] = 255
      }
    }
    x += barW + gap
  }
  return px
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length)
  out.write(type, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4)
  return out
}
const encodePng = (S, px) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(S, 0)
  ihdr.writeUInt32BE(S, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(S * (S * 4 + 1))
  for (let y = 0; y < S; y++)
    Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [size, file] of [
  [512, 'build/icon.png'],
  [256, 'src/renderer/public/icon.png'],
]) {
  writeFileSync(resolve(root, file), encodePng(size, render(size)))
  console.log(`wrote ${file} (${size}x${size})`)
}

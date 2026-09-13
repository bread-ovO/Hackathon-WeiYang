/** Bounded alpha cache; source rows follow WebGL's bottom-left origin. */
export const HIT_MAP_SIZE = 128
export const HIT_MAP_INTERVAL_MS = 100
export function createAlphaHitMap(width = HIT_MAP_SIZE, height = HIT_MAP_SIZE) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 256 ||
    height > 256
  )
    throw new Error('INVALID_HIT_MAP')
  const alpha = new Uint8Array(width * height)
  return {
    update(rgba: Uint8Array) {
      if (rgba.length !== width * height * 4) throw new Error('INVALID_HIT_MAP')
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!
    },
    clear() {
      alpha.fill(0)
    },
    hit(x: number, y: number, displayWidth: number, displayHeight: number) {
      if (
        ![x, y, displayWidth, displayHeight].every(Number.isFinite) ||
        displayWidth <= 0 ||
        displayHeight <= 0 ||
        x < 0 ||
        y < 0 ||
        x >= displayWidth ||
        y >= displayHeight
      )
        return false
      const column = Math.floor((x / displayWidth) * width)
      const row = height - 1 - Math.floor((y / displayHeight) * height)
      return alpha[row * width + column]! >= 16
    },
  }
}

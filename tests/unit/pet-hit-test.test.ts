import { describe, it, expect } from 'vitest'
import { createAlphaHitMap } from '../../apps/desktop/src/renderer/src/pet-hit-test'
describe('pet alpha hit map', () => {
  it('flips WebGL rows and scales CSS coordinates independently of DPR', () => {
    const map = createAlphaHitMap(2, 2),
      pixels = new Uint8Array(16)
    pixels[3] = 255
    map.update(pixels)
    expect(map.hit(25, 75, 100, 100)).toBe(true)
    expect(map.hit(25, 25, 100, 100)).toBe(false)
    expect(map.hit(75, 75, 100, 100)).toBe(false)
    expect(map.hit(50, 150, 200, 200)).toBe(true)
  })
  it('copies alpha, ignores transparent RGB and clears disposed maps', () => {
    const map = createAlphaHitMap(1, 1),
      pixels = new Uint8Array([255, 255, 255, 0])
    map.update(pixels)
    expect(map.hit(0, 0, 1, 1)).toBe(false)
    pixels[3] = 15
    map.update(pixels)
    expect(map.hit(0, 0, 1, 1)).toBe(false)
    pixels[3] = 16
    map.update(pixels)
    pixels[3] = 0
    expect(map.hit(0, 0, 1, 1)).toBe(true)
    map.clear()
    expect(map.hit(0, 0, 1, 1)).toBe(false)
  })
  it('rejects outside, nonfinite and zero geometry without edge clamping', () => {
    const map = createAlphaHitMap(1, 1)
    map.update(new Uint8Array([0, 0, 0, 255]))
    for (const [x, y, w, h] of [
      [-1, 0, 1, 1],
      [1, 0, 1, 1],
      [0, 1, 1, 1],
      [0, -1, 1, 1],
      [NaN, 0, 1, 1],
      [0, 0, 0, 1],
      [0, 0, 1, Infinity],
    ])
      expect(map.hit(x!, y!, w!, h!)).toBe(false)
  })
  it('bounds dimensions and buffer size', () => {
    for (const size of [0, -1, 257, 1.5, NaN])
      expect(() => createAlphaHitMap(size, 1)).toThrow('INVALID_HIT_MAP')
    expect(() => createAlphaHitMap(2, 2).update(new Uint8Array(4))).toThrow(
      'INVALID_HIT_MAP',
    )
  })
})

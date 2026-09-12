import { describe, expect, it } from 'vitest'
import {
  createPetFrameBudget,
  createPetRecoveryBudget,
  petTargetFps,
} from '../../apps/desktop/src/renderer/src/pet-frame-budget'

describe('pet render frame budget', () => {
  it.each([60, 120, 144])('preserves 15/30 fps on a %i Hz display', (hz) => {
    for (const fps of [15, 30] as const) {
      const budget = createPetFrameBudget()
      let frames = 0
      for (let i = 0; i < hz * 10; i++)
        if (budget.due((i * 1000) / hz, fps)) frames++
      expect(frames).toBeGreaterThanOrEqual(fps * 10 - 1)
      expect(frames).toBeLessThanOrEqual(fps * 10 + 1)
    }
  })
  it('retains fractional credit with jitter and when switching targets', () => {
    const budget = createPetFrameBudget()
    let frames = 0
    for (let i = 0; i < 600; i++) {
      const now = (i * 1000) / 60 + (i % 2 ? 2 : 0)
      if (budget.due(now, i < 300 ? 15 : 30)) frames++
    }
    expect(frames).toBeGreaterThanOrEqual(224)
    expect(frames).toBeLessThanOrEqual(226)
  })
  it('resets after a hidden interval without catching up multiple frames', () => {
    const budget = createPetFrameBudget()
    expect(budget.due(0, 30)).toBe(true)
    expect(budget.due(16, 30)).toBe(false)
    budget.reset()
    expect(budget.due(100000, 30)).toBe(true)
    expect(budget.due(100001, 30)).toBe(false)
    expect(budget.due(NaN, 30)).toBe(false)
    expect(budget.due(100034, 30)).toBe(true)
  })
  it('uses interaction and presentation activity, then returns to idle', () => {
    expect(petTargetFps(10000, -Infinity, false)).toBe(15)
    expect(petTargetFps(10000, 6001, false)).toBe(30)
    expect(petTargetFps(10000, 6000, false)).toBe(15)
    expect(petTargetFps(10000, -Infinity, true)).toBe(30)
  })
})
describe('pet context recovery budget', () => {
  it('allows at most two attempts in a sliding minute regardless of outcome', () => {
    const budget = createPetRecoveryBudget()
    expect(budget.take(0)).toBe(true)
    expect(budget.take(1000)).toBe(true)
    expect(budget.take(59999)).toBe(false)
    expect(budget.take(60000)).toBe(true)
    expect(budget.take(60001)).toBe(false)
    expect(budget.take(61000)).toBe(true)
  })
  it('does not accept invalid clocks', () => {
    const budget = createPetRecoveryBudget()
    expect(budget.take(NaN)).toBe(false)
    expect(budget.take(Infinity)).toBe(false)
    expect(budget.take(1)).toBe(true)
    expect(budget.take(2)).toBe(true)
    expect(budget.take(3)).toBe(false)
  })
})

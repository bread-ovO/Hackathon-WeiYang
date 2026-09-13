import { describe, expect, it } from 'vitest'
import {
  parseCoreRequest,
  parseHostRequest,
} from '../../packages/contracts/src/index'
describe('pet window preferences contract', () => {
  it.each([
    {
      method: 'pet.configure',
      patch: { scale: 0.5, alwaysOnTop: true, clickThrough: false },
    },
    { method: 'pet.configure', patch: { scale: 2 } },
    { method: 'pet.resetPosition' },
  ])('accepts main-only $method', (request) => {
    expect(parseCoreRequest(request)).toEqual(request)
    expect(() => parseHostRequest(request)).toThrow()
  })
  it.each([
    {},
    { scale: 0 },
    { scale: 2.01 },
    { scale: NaN },
    { scale: Infinity },
    { scale: '1' },
    { x: 20 },
    { alwaysOnTop: 1 },
    { clickThrough: null },
    { path: '/tmp/a' },
  ])('rejects invalid preferences %j', (patch) => {
    expect(() => parseCoreRequest({ method: 'pet.configure', patch })).toThrow()
  })
  it('does not accept arbitrary placement or window identifiers', () => {
    expect(() =>
      parseCoreRequest({ method: 'pet.resetPosition', windowId: 1 }),
    ).toThrow()
    expect(() =>
      parseCoreRequest({
        method: 'pet.configure',
        patch: { scale: 1 },
        windowId: 1,
      }),
    ).toThrow()
  })
})

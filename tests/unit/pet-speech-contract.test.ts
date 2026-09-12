import { describe, expect, it } from 'vitest'
import {
  parseCoreRequest,
  parseHostRequest,
  parsePetRequest,
} from '../../packages/contracts/src/index'
describe('pet automatic speech contract', () => {
  it.each([
    { enabled: true },
    { enabled: false },
    { frequency: 'low' },
    { frequency: 'normal' },
    { quietStart: 0, quietEnd: 1439 },
    { quietStart: 540, quietEnd: 540 },
    { pausedUntil: null },
    { pausedUntil: 1789315200000 },
  ])('accepts bounded explicit preferences', (patch) => {
    const request = { method: 'pet.configureSpeech', patch }
    expect(parseCoreRequest(request)).toEqual(request)
    expect(parsePetRequest(request)).toEqual(request)
    expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
  })
  it.each([
    {},
    null,
    [],
    { enabled: 1 },
    { frequency: 'high' },
    { quietStart: -1 },
    { quietEnd: 1440 },
    { quietStart: 9.5 },
    { pausedUntil: -1 },
    { pausedUntil: NaN },
    { pausedUntil: Infinity },
    { pausedUntil: 1.5 },
    { pausedUntil: Number.MAX_SAFE_INTEGER },
    { text: 'auto text' },
    { enabled: true, actor: 'model' },
    { enabled: true, secret: 'token' },
    { enabled: true, quietHours: { start: 0 } },
  ])('rejects malformed or unexpected fields', (patch) => {
    expect(() =>
      parseCoreRequest({ method: 'pet.configureSpeech', patch }),
    ).toThrow()
  })
  it('rejects extra top-level fields and missing patches', () => {
    expect(() =>
      parseCoreRequest({
        method: 'pet.configureSpeech',
        patch: { enabled: true },
        path: '/private',
      }),
    ).toThrow()
    expect(() => parseCoreRequest({ method: 'pet.configureSpeech' })).toThrow()
  })
})

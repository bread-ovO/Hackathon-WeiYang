import { describe, it, expect } from 'vitest'
import {
  parsePetVoicePreferences,
  parseCoreRequest,
  parseHostRequest,
} from '@memo/contracts'
const preferences = {
  version: 1,
  enabled: false,
  voiceId: null,
  volume: 0.6,
  rate: 1,
}
describe('system voice boundary', () => {
  it('snapshots valid defaults and explicit voice', () => {
    const parsed = parsePetVoicePreferences(preferences)
    expect(parsed).toEqual(preferences)
    expect(parsed).not.toBe(preferences)
    expect(
      parsePetVoicePreferences({
        ...preferences,
        enabled: true,
        voiceId: 'com.apple.voice.synthetic',
      }).enabled,
    ).toBe(true)
  })
  for (const patch of [
    { enabled: true },
    { volume: NaN },
    { volume: Infinity },
    { volume: -0.1 },
    { volume: 1.1 },
    { rate: 0.74 },
    { rate: 1.26 },
    { version: 0 },
    { voiceId: '' },
    { voiceId: 'a\nb' },
    { endpoint: 'https://example.test' },
    { text: 'injected' },
  ])
    it(`rejects invalid ${JSON.stringify(patch)}`, () =>
      expect(() =>
        parsePetVoicePreferences({ ...preferences, ...patch }),
      ).toThrow('PET_VOICE_INVALID'))
  for (const request of [
    { method: 'pet.voiceState' },
    { method: 'pet.stopVoice' },
    {
      method: 'pet.configureVoice',
      expectedVersion: 1,
      preferences: {
        enabled: true,
        voiceId: 'synthetic',
        volume: 0,
        rate: 0.75,
      },
    },
  ])
    it(`main only ${request.method}`, () => {
      expect(parseCoreRequest(request)).toEqual(request)
      expect(() => parseHostRequest(request)).toThrow()
    })
  it('does not accept renderer supplied speech or PCM', () => {
    expect(() =>
      parseCoreRequest({ method: 'pet.stopVoice', text: 'speak' }),
    ).toThrow()
    expect(() =>
      parseCoreRequest({
        method: 'pet.configureVoice',
        expectedVersion: 1,
        preferences: { ...preferences, pcm: 'AA==' },
      }),
    ).toThrow()
  })
})

import { describe, it, expect } from 'vitest'
import {
  parsePetContextConfig,
  parseCoreRequest,
  parseHostRequest,
} from '@memo/contracts'
const config = {
  version: 1,
  enabled: false,
  projectIds: [],
  useModel: false,
  model: '',
}
describe('context speech public boundary', () => {
  it('accepts explicit disabled defaults and snapshots configuration', () => {
    const parsed = parsePetContextConfig(config)
    expect(parsed).toEqual(config)
    expect(parsed).not.toBe(config)
  })
  it.each([
    { ...config, useModel: true },
    { ...config, model: 'model:cloud' },
    { ...config, model: 'model-CLOUD' },
    { ...config, endpoint: 'https://evil' },
    { ...config, projectIds: ['a', 'b', 'c', 'd'] },
  ])('rejects hidden network capabilities and invalid scope', (value) =>
    expect(() => parsePetContextConfig(value)).toThrow(),
  )
  it.each([
    { method: 'pet.contextState' },
    { method: 'pet.previewContext' },
    { method: 'pet.cancelContext' },
    { method: 'pet.showContext', id: 'opaque' },
    {
      method: 'pet.configureContext',
      expectedVersion: 1,
      config: { enabled: true, projectIds: ['p'], useModel: false, model: '' },
    },
  ])('routes only through main capability', (request) => {
    expect(parseCoreRequest(request)).toEqual(request)
    expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
  })
  it.each([
    { method: 'pet.previewContext', text: 'injected' },
    { method: 'pet.showContext', id: 'opaque', taskId: 'injected' },
    {
      method: 'pet.configureContext',
      expectedVersion: 0,
      config: { enabled: true, projectIds: [], useModel: false, model: '' },
    },
  ])('rejects injected text and IDs', (request) =>
    expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST'),
  )
})

import { describe, expect, it } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
describe('local processing bridge', () => {
  it.each([
    { method: 'processing.status' },
    { method: 'processing.configure', enabled: false },
    { method: 'processing.configure', enabled: true },
  ])('allows the fixed status and enable controls', (request) => {
    expect(parseCoreRequest(request)).toEqual(request)
    expect(parseHostRequest(request)).toEqual(request)
  })
  it.each([
    { method: 'processing.configure' },
    { method: 'processing.configure', enabled: 'true' },
    { method: 'processing.status', projectId: 'other' },
    { method: 'processing.configure', enabled: true, text: 'untrusted' },
    { method: 'processing.run' },
  ])('rejects scope or payload injection', (request) => {
    expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
    expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
  })
})

import { describe, expect, it } from 'vitest'
import {
  parseCoreRequest,
  parseHostRequest,
  parsePetActionCatalog,
} from '../../packages/contracts/src/index'
describe('pet action catalog and presentation contract', () => {
  it('maps original manifest order to ids without exposing resource files', () => {
    const result = parsePetActionCatalog({
      FileReferences: {
        Motions: {
          Idle: [{ File: 'private/idle.motion3.json' }],
          TapBody: [{ File: 'private/body.motion3.json' }],
        },
        Expressions: [{ Name: '笑容', File: 'private/smile.exp3.json' }],
      },
    })
    expect(result).toEqual({
      motions: [
        { id: 'motion:0:0', label: 'Idle 1' },
        { id: 'motion:1:0', label: 'TapBody 1' },
      ],
      expressions: [{ id: 'expression:0', label: '笑容' }],
    })
    expect(JSON.stringify(result)).not.toContain('private/')
  })
  it('allows models without optional actions', () =>
    expect(parsePetActionCatalog({ FileReferences: {} })).toEqual({
      motions: [],
      expressions: [],
    }))
  it.each([
    null,
    { FileReferences: [] },
    { FileReferences: { Motions: { Idle: 'invalid' } } },
    { FileReferences: { Expressions: [{ File: 'x' }] } },
    {
      FileReferences: {
        Motions: { Idle: Array.from({ length: 65 }, () => ({ File: 'x' })) },
      },
    },
  ])('rejects malformed or oversized catalogs', (input) =>
    expect(() => parsePetActionCatalog(input)).toThrow('INVALID_PET_ACTIONS'),
  )
  it.each([
    { method: 'pet.play', actionId: 'motion:0:0' },
    { method: 'pet.play', actionId: 'expression:0' },
    {
      method: 'pet.speak',
      input: { text: '两行\n文字', actionId: 'expression:0' },
    },
    { method: 'pet.dismissBubble' },
  ])('keeps presentation only at main boundary', (request) => {
    expect(parseCoreRequest(request)).toEqual(request)
    expect(() => parseHostRequest(request)).toThrow()
  })
  it.each([
    { method: 'pet.play', actionId: '/private/model.motion3.json' },
    { method: 'pet.play', actionId: 'motion:0:0', path: '/private' },
    { method: 'pet.speak', input: { text: '' } },
    { method: 'pet.speak', input: { text: 'x'.repeat(241) } },
    { method: 'pet.speak', input: { text: 'hello', html: true } },
    { method: 'pet.dismissBubble', id: 'other' },
  ])('rejects malformed presentation', (request) =>
    expect(() => parseCoreRequest(request)).toThrow(),
  )
})

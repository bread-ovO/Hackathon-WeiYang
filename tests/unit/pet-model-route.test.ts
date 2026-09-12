import { describe, expect, it } from 'vitest'
import { resolveModelResource } from '../../apps/desktop/src/main/pet/model-route'

const root = process.platform === 'win32' ? 'C:\\app-data\\pet-models' : '/app-data/pet-models'
const id = 'a'.repeat(64)

describe('controlled model route', () => {
  it('maps a well-formed model resource into the store', () => {
    expect(resolveModelResource(`/models/${id}/pet.model3.json`, root)).toBeTruthy()
    expect(resolveModelResource(`/models/${id}/tex/00.png`, root)).toBeTruthy()
  })
  it('accepts only 64-hex model ids', () => {
    expect(resolveModelResource(`/models/short/pet.png`, root)).toBeNull()
    expect(resolveModelResource(`/models/${'A'.repeat(64)}/pet.png`, root)).toBeNull()
  })
  it('refuses traversal, absolute and encoded escape attempts', () => {
    expect(resolveModelResource(`/models/${id}/../neighbor/x`, root)).toBeNull()
    expect(resolveModelResource(`/models/${id}/..%2fneighbor/x`, root)).toBeNull()
    expect(resolveModelResource(`/models/${id}/a:b.png`, root)).toBeNull()
    expect(resolveModelResource(`/models/${id}/`, root)).toBeNull()
  })
  it('ignores every other pathname', () => {
    expect(resolveModelResource('/index.html', root)).toBeNull()
    expect(resolveModelResource(`/model/x/pet.png`, root)).toBeNull()
    expect(resolveModelResource(`/models`, root)).toBeNull()
  })
})

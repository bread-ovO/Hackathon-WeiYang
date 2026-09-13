import { describe, expect, it } from 'vitest'
import {
  parseCoreRequest,
  parseHostRequest,
} from '../../packages/contracts/src'
const valid = {
  method: 'workspace.timeline',
  projectId: 'project',
  taskId: 'task',
}
describe('task timeline typed boundary', () => {
  it('accepts scoped bounded pagination in core and host', () => {
    expect(parseCoreRequest(valid)).toEqual(valid)
    expect(parseHostRequest({ ...valid, limit: 50, cursor: 'opaque' })).toEqual(
      { ...valid, limit: 50, cursor: 'opaque' },
    )
  })
  it.each([
    { projectId: '' },
    { taskId: ' a' },
    { taskId: 'a\n' },
    { projectId: 'a'.repeat(257) },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { limit: '20' },
    { cursor: '' },
    { cursor: 'a'.repeat(4097) },
    { cursor: null },
    { path: '/private/data' },
    { actorId: 'pretend' },
    { includeSourceText: true },
  ])('rejects invalid or extra fields %j', (patch) => {
    expect(() => parseCoreRequest({ ...valid, ...patch })).toThrow()
  })
  it('requires both project and task scope', () => {
    expect(() =>
      parseCoreRequest({ method: valid.method, projectId: 'p' }),
    ).toThrow()
    expect(() =>
      parseCoreRequest({ method: valid.method, taskId: 't' }),
    ).toThrow()
  })
})

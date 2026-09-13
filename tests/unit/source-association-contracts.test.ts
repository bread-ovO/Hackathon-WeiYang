import { describe, expect, it } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
const scope = { projectId: 'project', taskId: 'task' }
const binding = {
  method: 'workspace.bindSourceObject',
  ...scope,
  eventId: 1,
  expectedTaskVersion: 1,
  expectedCriteriaVersion: 0,
  expectedManualVersion: 0,
  reason: '核实具体来源对象',
}
const mapping = {
  method: 'workspace.confirmIdentityMapping',
  ...scope,
  leftEventId: 1,
  rightEventId: 2,
  expectedLeftBindingVersion: 1,
  expectedRightBindingVersion: 1,
  expectedMappingVersion: 0,
  reason: '核实两端身份',
}
describe('scoped source association bridge', () => {
  it.each([
    { method: 'workspace.sourceEvents', projectId: 'project', limit: 50 },
    { method: 'workspace.sourceBindings', ...scope },
    binding,
    {
      method: 'workspace.revokeSourceBinding',
      ...scope,
      id: 'binding',
      expectedVersion: 1,
      reason: '取消关联',
    },
    { method: 'workspace.identityMappings', ...scope },
    mapping,
    {
      method: 'workspace.revokeIdentityMapping',
      ...scope,
      id: 'mapping',
      expectedVersion: 1,
      reason: '取消直接映射',
    },
    {
      method: 'workspace.reevaluatePlanChange',
      ...scope,
      eventId: 2,
      expectedVersion: 1,
      expectedCriteriaVersion: 0,
      expectedManualVersion: 0,
      reason: '核实指定记录',
    },
  ])('accepts only typed public fields', (request) => {
    expect(parseCoreRequest(request)).toEqual(request)
    expect(parseHostRequest(request)).toEqual(request)
  })
  it.each([
    { ...binding, eventId: 'forged' },
    { ...binding, actorId: 'admin' },
    { ...binding, author: { subjectId: 'forged' } },
    { ...binding, reason: '  ' },
    { ...mapping, expectedMappingVersion: -1 },
    { ...mapping, left: { namespace: 'name', subjectId: 'injected' } },
    { method: 'workspace.sourceEvents', projectId: 'p', limit: 51 },
    { method: 'workspace.sourceEvents', projectId: 'p', path: '/private' },
    {
      method: 'workspace.reevaluatePlanChange',
      ...scope,
      eventId: 1,
      expectedVersion: 1,
      expectedCriteriaVersion: 0,
      expectedManualVersion: 0,
      reason: '\n',
    },
  ])('rejects forged identities, paths and invalid CAS', (request) => {
    expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
    expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
  })
})

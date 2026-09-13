import { describe, expect, it } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
const confirm = {
  method: 'workspace.confirmPlanChange',
  projectId: 'project',
  taskId: 'task',
  proposalId: 1,
  expectedAssessmentVersion: 0,
  expectedVersion: 1,
  expectedCriteriaVersion: 0,
  expectedManualVersion: 0,
  reason: '我已核实该明确计划',
}
describe('bounded plan-change bridge', () => {
  it.each([
    { method: 'workspace.planChanges', projectId: 'project', taskId: 'task' },
    confirm,
  ])('accepts fixed core requests', (request) => {
    expect(parseCoreRequest(request)).toEqual(request)
    expect(parseHostRequest(request)).toEqual(request)
  })
  it.each([
    { ...confirm, reason: '   ' },
    { ...confirm, reason: 'bad\nreason' },
    { ...confirm, expectedVersion: -1 },
    { ...confirm, expectedAssessmentVersion: -1 },
    { ...confirm, proposalId: 0 },
    { ...confirm, actorId: 'forged' },
    { ...confirm, dueAt: '2026-09-20T00:00:00.000Z' },
    { method: 'workspace.planChanges', projectId: 'p', taskId: 't', limit: 51 },
    {
      method: 'workspace.planChanges',
      projectId: 'p',
      taskId: 't',
      path: '/tmp/private',
    },
  ])('rejects unauthorized fields and invalid CAS', (request) => {
    expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
    expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
  })
})

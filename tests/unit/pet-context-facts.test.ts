import { describe, it, expect } from 'vitest'
import { parseCoreRequest } from '../../packages/contracts/src'
const fact = {
  projectId: 'p',
  taskId: 't',
  taskVersion: 1,
  criteriaVersion: 0,
  manualVersion: 0,
  title: '真实标题',
  status: 'todo',
  referenceId: 'manual:one',
  eventId: 1,
  proof: 'a'.repeat(64),
}
describe('pet fact contract boundary', () => {
  it('accepts only scoped small projections', () => {
    expect(
      parseCoreRequest({
        method: 'workspace.petContextFacts',
        projectIds: ['p', 'q', 'r'],
      }),
    ).toBeTruthy()
    expect(
      parseCoreRequest({ method: 'workspace.validatePetContextFact', fact }),
    ).toBeTruthy()
  })
  it.each([
    { projectIds: ['p', 'q', 'r', 's'] },
    { projectIds: ['p', 'p'] },
    { projectIds: [''] },
    { projectIds: ['x\n'] },
  ])('rejects invalid project scope %j', ({ projectIds }) =>
    expect(() =>
      parseCoreRequest({ method: 'workspace.petContextFacts', projectIds }),
    ).toThrow(),
  )
  it.each([
    { quote: 'secret' },
    { title: 'x'.repeat(121) },
    { title: '\u202eSpoof' },
    { status: 'probably_done' },
    { referenceId: 'unknown:x' },
    { eventId: 0 },
    { proof: 'x' },
    { taskVersion: 1.5 },
  ])('rejects invented or extra fact fields %j', (patch) =>
    expect(() =>
      parseCoreRequest({
        method: 'workspace.validatePetContextFact',
        fact: { ...fact, ...patch },
      }),
    ).toThrow(),
  )
})

import { describe, expect, it, vi } from 'vitest'
import { parseCoreRequest } from '@memo/contracts'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'

const update = {
  method: 'workspace.updateTask',
  projectId: 'project-1',
  id: 'task-1',
  expectedVersion: 1,
  expectedCriteriaVersion: 1,
  expectedManualVersion: 0,
  patch: { status: 'completed' },
}
const invalidRequests: unknown[] = [
  { method: 'workspace.deleteAll' },
  { method: 'workspace.list', projectId: 'secret-project' },
  { method: 'workspace.createProject', name: '' },
  { method: 'workspace.createProject', name: 'x'.repeat(129) },
  { method: 'workspace.createProject', name: 'Project', actorId: 'other-user' },
  { method: 'workspace.createTask', projectId: '', title: 'Task' },
  { method: 'workspace.createTask', projectId: 'x'.repeat(257), title: 'Task' },
  { method: 'workspace.createTask', projectId: 1, title: 'Task' },
  {
    method: 'workspace.createTask',
    projectId: 'project-1',
    title: 'x'.repeat(513),
  },
  {
    method: 'workspace.createTask',
    projectId: 'project-1',
    title: 'Task',
    admission: 'accepted',
    actor: 'model',
  },
  { ...update, projectId: null },
  { ...update, id: '' },
  { ...update, actorId: 'other-user' },
  { ...update, patch: { actorId: 'other-user' } },
  { ...update, patch: { actor: 'model', status: 'completed' } },
  { ...update, patch: { evidenceStatus: 'sufficient' } },
  { ...update, patch: { version: 999 } },
  { ...update, patch: { projectId: 'other-project' } },
  { ...update, patch: { status: 'complete' } },
  { ...update, patch: { archived: 'true' } },
  { ...update, patch: {} },
  { ...update, patch: null },
  { ...update, patch: [] },
]
for (const field of [
  'expectedVersion',
  'expectedCriteriaVersion',
  'expectedManualVersion',
]) {
  for (const value of [
    undefined,
    -1,
    0.5,
    '1',
    null,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    invalidRequests.push({ ...update, [field]: value })
}
invalidRequests.push({ ...update, expectedVersion: 0 })

describe('workspace request boundary', () => {
  it('accepts only named, bounded project/task operations', () => {
    for (const request of [
      { method: 'workspace.list' },
      { method: 'workspace.createProject', name: '中文项目' },
      {
        method: 'workspace.createTask',
        projectId: 'project-1',
        title: '提交 PR',
      },
      update,
      { ...update, expectedCriteriaVersion: 0, expectedManualVersion: 0 },
      {
        ...update,
        patch: { title: '新标题', archived: true, status: 'waiting' },
      },
    ])
      expect(parseCoreRequest(request)).toEqual(request)
  })
  it.each(invalidRequests.map((request, index) => ({ index, request })))(
    'rejects malformed workspace request $index before core dispatch',
    async ({ request }) => {
      expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
      const frame = { url: 'memo://app/index.html' }
      const renderer = { mainFrame: frame, isDestroyed: () => false }
      const dispatch = vi.fn(async () => ({
        ok: false as const,
        error: 'CORE_UNAVAILABLE' as const,
      }))
      const handler = createRequestHandler(() => renderer, frame.url, dispatch)
      expect(
        await handler({ sender: renderer, senderFrame: frame }, request),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
      expect(dispatch).not.toHaveBeenCalled()
    },
  )
  it('applies sender and frame validation to workspace mutations as well as health', async () => {
    const frame = { url: 'memo://app/index.html' }
    const renderer = { mainFrame: frame, isDestroyed: () => false }
    const dispatch = vi.fn(async () => ({
      ok: false as const,
      error: 'CORE_UNAVAILABLE' as const,
    }))
    const handler = createRequestHandler(() => renderer, frame.url, dispatch)
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: renderer, senderFrame: { url: frame.url } },
    ])
      expect(await handler(event, update)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

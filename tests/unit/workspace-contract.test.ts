import { describe, expect, it, vi } from 'vitest'
import { parseCoreRequest } from '@memo/contracts'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'
import { handleWorkspace } from '../../apps/desktop/src/core/workspace'

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

describe('workspace filtering, detail and versioned criteria contract', () => {
  const replace = {
    ...update,
    method: 'workspace.replaceCriteria',
    criteria: [{ id: 'criterion-1', description: '反馈链接' }],
  }
  const { patch: _patch, ...criteriaRequest } = replace
  it('keeps old list calls compatible and accepts bounded queries and scoped detail', () => {
    for (const request of [
      { method: 'workspace.list' },
      {
        method: 'workspace.list',
        query: {
          projectId: null,
          status: 'waiting',
          admission: 'accepted',
          archive: 'all',
          query: '中文',
          limit: 100,
          cursor: 'opaque-cursor',
        },
      },
      {
        method: 'workspace.detail',
        projectId: 'project-1',
        id: 'task-1',
        criteriaVersion: 0,
      },
      criteriaRequest,
      {
        ...criteriaRequest,
        criteria: [{ id: 'a', description: '保留原文', originEventId: 1 }],
      },
      { ...criteriaRequest, criteria: [] },
      { ...update, patch: { dueAt: null, admission: 'accepted' } },
      { ...update, patch: { dueAt: '2028-02-29T12:34:56.123Z' } },
    ])
      expect(parseCoreRequest(request)).toEqual(request)
  })
  it.each([
    { method: 'workspace.list', query: { limit: 101 } },
    { method: 'workspace.list', query: { limit: 0 } },
    { method: 'workspace.list', query: { limit: 1.5 } },
    { method: 'workspace.list', query: { projectId: '' } },
    { method: 'workspace.list', query: { archive: 'yes' } },
    { method: 'workspace.list', query: { query: 'x'.repeat(257) } },
    { method: 'workspace.list', query: { cursor: 'x'.repeat(4097) } },
    { method: 'workspace.list', query: { sql: 'DELETE FROM tasks' } },
    { method: 'workspace.detail', id: 'task-1' },
    {
      method: 'workspace.detail',
      projectId: 'project-1',
      id: 'task-1',
      criteriaVersion: -1,
    },
    {
      method: 'workspace.detail',
      projectId: 'project-1',
      id: 'task-1',
      criteriaVersion: Number.MAX_SAFE_INTEGER + 1,
    },
    { ...criteriaRequest, expectedVersion: 0 },
    { ...criteriaRequest, actor: 'model' },
    { ...criteriaRequest, criteria: [{ id: 'a', description: '' }] },
    {
      ...criteriaRequest,
      criteria: [{ id: 'a', description: 'x'.repeat(513) }],
    },
    {
      ...criteriaRequest,
      criteria: [{ id: 'a', description: 'ok', originEventId: 0 }],
    },
    {
      ...criteriaRequest,
      criteria: [
        { id: 'a', description: 'one' },
        { id: 'a', description: 'two' },
      ],
    },
    {
      ...criteriaRequest,
      criteria: Array.from({ length: 33 }, (_, id) => ({
        id: String(id),
        description: 'ok',
      })),
    },
    {
      ...criteriaRequest,
      criteria: Array.from({ length: 32 }, (_, id) => ({
        id: String(id),
        description: 'x'.repeat(512),
      })),
    },
  ])('rejects malformed new operation %#', (request) => {
    expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
  })
  it.each([
    '2026-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:60Z',
    '0000-01-01T00:00:00Z',
    '2026-01-01T00:00:00',
    '2026-01-01T00:00:00+08:00',
    '2026-01-01T00:00:00.1234Z',
    'tomorrow',
  ])('rejects noncanonical or invalid due date %s', (dueAt) => {
    expect(() => parseCoreRequest({ ...update, patch: { dueAt } })).toThrow(
      'INVALID_REQUEST',
    )
  })
})

describe('task split request boundary', () => {
  const split = {
    method: 'workspace.splitTask' as const,
    projectId: 'project-1',
    taskId: 'task-1',
    expectedVersion: 1,
    expectedCriteriaVersion: 2,
    expectedManualVersion: 0,
    children: [{ title: '拆分新事项', criterionIds: ['criterion-1'] }],
  }
  it('accepts typed split requests', () => {
    for (const request of [
      split,
      {
        ...split,
        children: [
          { title: 'A', criterionIds: ['c1', 'c2'] },
          { title: 'B', criterionIds: ['c3'] },
        ],
      },
    ])
      expect(parseCoreRequest(request)).toEqual(request)
  })
  it.each([
    { method: 'workspace.splitTask' },
    { ...split, children: [] },
    {
      ...split,
      children: Array.from({ length: 5 }, (_, i) => ({
        title: `t${i}`,
        criterionIds: ['c1'],
      })),
    },
    { ...split, children: [{ title: '', criterionIds: ['c1'] }] },
    { ...split, children: [{ title: 'x'.repeat(513), criterionIds: ['c1'] }] },
    { ...split, children: [{ title: 'ok', criterionIds: [] }] },
    { ...split, children: [{ title: 'ok', criterionIds: ['c1'], extra: 1 }] },
    {
      ...split,
      children: [
        {
          title: 'ok',
          criterionIds: Array.from({ length: 33 }, (_, i) => `c${i}`),
        },
      ],
    },
    { ...split, expectedVersion: 0 },
    { ...split, taskId: null },
  ])('rejects malformed split request %#', (request) => {
    expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
  })
  it('dispatches split through the core workspace handler', () => {
    const splitOutcome = { parent: { id: 'task-1' }, children: [{ id: 'new' }] }
    const tasks = { split: vi.fn(() => splitOutcome) }
    const store = { tasks } as unknown as ReturnType<
      typeof import('../../packages/storage/src/index').openStore
    >
    expect(handleWorkspace(store, split)).toBe(splitOutcome)
    const { method: _s, ...splitInput } = split
    expect(tasks.split).toHaveBeenCalledExactlyOnceWith(
      splitInput,
      { actorId: 'local-user', reason: '用户在我的工作区手动操作' },
    )
  })
})

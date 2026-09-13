import { describe, it, expect, vi } from 'vitest'
import {
  parseCoreRequest,
  parseHostRequest,
} from '../../packages/contracts/src/index'
import { handleWorkspace } from '../../apps/desktop/src/core/workspace'
import type { openStore } from '../../packages/storage/src/index'
const scope = {
  projectId: 'project-1',
  taskId: 'task-1',
  referenceKind: 'processing' as const,
  referenceId: '123',
}
const confirm = {
  method: 'workspace.confirmReference' as const,
  ...scope,
  chosenEventId: 7,
  knownContentSetDigest: 'a'.repeat(64),
  expectedReferenceVersion: 0,
  reason: '确认使用这条已知消息',
}
describe('specific reference review IPC contract', () => {
  it.each([
    {
      method: 'workspace.listReferences',
      projectId: scope.projectId,
      taskId: scope.taskId,
    },
    {
      method: 'workspace.reviewReference',
      ...scope,
      limit: 50,
      cursor: 'opaque-page',
    },
    confirm,
    { ...confirm, referenceKind: 'manual', referenceId: 'reference-abc' },
  ])('accepts typed public and core request %j', (request) => {
    expect(parseCoreRequest(request)).toEqual(request)
    expect(parseHostRequest(request)).toEqual(request)
  })
  it.each([
    'actorId',
    'actor',
    'path',
    'token',
    'quote',
    'patch',
    'status',
    'manualVersion',
    'eventId',
  ])('rejects renderer-supplied %s', (field) => {
    expect(() => parseCoreRequest({ ...confirm, [field]: 'forged' })).toThrow()
  })
  it.each(['chosenEventId', 'expectedReferenceVersion'] as const)(
    'requires safe integer %s',
    (field) => {
      for (const value of [
        NaN,
        Infinity,
        1.5,
        Number.MAX_SAFE_INTEGER + 1,
        '1',
        null,
        -1,
      ])
        expect(() => parseCoreRequest({ ...confirm, [field]: value })).toThrow()
      expect(() => parseCoreRequest({ ...confirm, chosenEventId: 0 })).toThrow()
    },
  )
  it.each(['projectId', 'taskId', 'referenceId'] as const)(
    'bounds opaque scope field %s',
    (field) => {
      for (const value of ['', ' spaced', 'x\0y', 'a'.repeat(257), {}, null])
        expect(() => parseCoreRequest({ ...confirm, [field]: value })).toThrow()
    },
  )
  it.each([
    '',
    'A'.repeat(64),
    'z'.repeat(64),
    'a'.repeat(63),
    'a'.repeat(65),
    null,
  ])('requires exact content-set digest %j', (knownContentSetDigest) => {
    expect(() =>
      parseCoreRequest({ ...confirm, knownContentSetDigest }),
    ).toThrow()
  })
  it.each(['', ' ', '\n', 'a\0b', 'a'.repeat(513), null])(
    'requires bounded explicit reason %j',
    (reason) => {
      expect(() => parseCoreRequest({ ...confirm, reason })).toThrow()
    },
  )
  it('rejects unknown reference kinds and paging on confirmation', () => {
    expect(() =>
      parseCoreRequest({ ...confirm, referenceKind: 'event' }),
    ).toThrow()
    expect(() => parseCoreRequest({ ...confirm, cursor: 'next' })).toThrow()
  })
  it.each(['workspace.listReferences', 'workspace.reviewReference'] as const)(
    'bounds review paging for %s',
    (method) => {
      const input =
        method === 'workspace.listReferences'
          ? { projectId: scope.projectId, taskId: scope.taskId }
          : scope
      for (const limit of [0, -1, 1.5, 51, '50'])
        expect(() => parseCoreRequest({ method, ...input, limit })).toThrow()
      for (const cursor of ['', 'a'.repeat(4097), 'a\0b', true])
        expect(() => parseCoreRequest({ method, ...input, cursor })).toThrow()
    },
  )
  it('does not accept confirmation without CAS or an explicit chosen event', () => {
    for (const field of [
      'knownContentSetDigest',
      'chosenEventId',
      'expectedReferenceVersion',
      'reason',
    ]) {
      const input = { ...confirm } as Record<string, unknown>
      delete input[field]
      expect(() => parseCoreRequest(input)).toThrow()
    }
  })
})
describe('core reference scope and actor projection', () => {
  it('passes only parsed reference scope and fixes the actor in the core', () => {
    const review = {
      reference: { kind: 'processing', id: '123' },
      confirmation: { actorId: 'local-user' },
    }
    const revisionReview = {
      reviewReference: vi.fn(() => review),
      confirmReference: vi.fn(() => review),
      listReferences: vi.fn(() => ({ references: [], nextCursor: null })),
    }
    const store = { revisionReview } as unknown as ReturnType<typeof openStore>
    expect(handleWorkspace(store, confirm)).toBe(review)
    const { method: _, ...input } = confirm
    expect(revisionReview.confirmReference).toHaveBeenCalledExactlyOnceWith(
      input,
      'local-user',
    )
    handleWorkspace(store, {
      method: 'workspace.reviewReference',
      ...scope,
      limit: 2,
    })
    expect(revisionReview.reviewReference).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      limit: 2,
    })
    expect(
      handleWorkspace(store, {
        method: 'workspace.listReferences',
        projectId: 'p',
        taskId: 't',
      }),
    ).toEqual({ references: [], nextCursor: null })
    expect(revisionReview.listReferences).toHaveBeenCalledExactlyOnceWith({
      projectId: 'p',
      taskId: 't',
    })
  })
  it('preserves fixed storage conflicts instead of treating them as success', () => {
    const store = {
      revisionReview: {
        confirmReference: () => {
          throw Error('REFERENCE_REVIEW_CONFLICT')
        },
      },
    } as unknown as ReturnType<typeof openStore>
    expect(() => handleWorkspace(store, confirm)).toThrow(
      'REFERENCE_REVIEW_CONFLICT',
    )
  })
})

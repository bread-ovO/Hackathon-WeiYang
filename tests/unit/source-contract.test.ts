import { describe, expect, it, vi } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'

const projectId = 'project-1'
const internal = {
  method: 'sources.importFile',
  projectId,
  path: '/tmp/fictional-events.jsonl',
}
const invalid = [
  internal,
  { method: 'sources.list', path: '/private' },
  { method: 'sources.list', cursor: 'untrusted' },
  { method: 'sources.chooseFile', projectId, path: '/private' },
  { method: 'sources.chooseFile', projectId, grantVersion: 1 },
  { method: 'sources.chooseFile', projectId: '' },
  { method: 'sources.chooseFile', projectId: 'x'.repeat(257) },
  { method: 'sources.chooseFile', projectId: ' project' },
  { method: 'sources.chooseFile', projectId: null },
  { method: 'sources.sync', id: '' },
  { method: 'sources.sync', id: 'x'.repeat(129) },
  { method: 'sources.sync', id: 1 },
  { method: 'sources.sync', id: 'source-1', path: '/private' },
  { method: 'sources.sync', id: 'source-1', cursor: 'forged' },
  { method: 'sources.revoke', id: 'source-1', actor: 'other-user' },
  { method: 'sources.revoke', id: 'source-1', grantVersion: 99 },
  { method: 'sources.revoke', id: '\0' },
]

describe('renderer sources capability boundary', () => {
  it('accepts only named operations with bounded identifiers', () => {
    for (const request of [
      { method: 'sources.list' },
      { method: 'sources.chooseFile', projectId },
      { method: 'sources.sync', id: 'source-1' },
      { method: 'sources.revoke', id: 'source-1' },
    ])
      expect(parseCoreRequest(request)).toEqual(request)
  })
  it.each(invalid)(
    'rejects path/cursor/grant injection or malformed input %# before dispatch',
    async (request) => {
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
  it('rejects chooser, sync and revoke from a foreign window or child frame', async () => {
    const frame = { url: 'memo://app/index.html' }
    const renderer = { mainFrame: frame, isDestroyed: () => false }
    const dispatch = vi.fn(async () => ({
      ok: false as const,
      error: 'CORE_UNAVAILABLE' as const,
    }))
    const handler = createRequestHandler(() => renderer, frame.url, dispatch)
    for (const request of [
      { method: 'sources.list' },
      { method: 'sources.chooseFile', projectId },
      { method: 'sources.sync', id: 's' },
      { method: 'sources.revoke', id: 's' },
    ]) {
      for (const event of [
        { sender: {}, senderFrame: frame },
        { sender: renderer, senderFrame: { url: frame.url } },
      ])
        expect(await handler(event, request)).toEqual({
          ok: false,
          error: 'INVALID_REQUEST',
        })
    }
    expect(dispatch).not.toHaveBeenCalled()
  })
})

describe('host-only file import boundary', () => {
  it('accepts native absolute file selections only internally', () => {
    for (const path of [
      '/tmp/fictional-events.jsonl',
      'C:\\fixtures\\events.jsonl',
      '\\\\server\\fixtures\\events.jsonl',
    ])
      expect(parseHostRequest({ ...internal, path })).toEqual({
        ...internal,
        path,
      })
    expect(parseHostRequest({ method: 'health' })).toEqual({ method: 'health' })
    expect(parseHostRequest({ method: 'sources.sync', id: 's' })).toEqual({
      method: 'sources.sync',
      id: 's',
    })
  })
  it.each([
    'relative.jsonl',
    '',
    'file:///tmp/test',
    '/tmp/a\0b',
    'x'.repeat(4097),
  ])('rejects invalid host file path %s', (path) => {
    expect(() => parseHostRequest({ ...internal, path })).toThrow(
      'INVALID_REQUEST',
    )
  })
  it('does not forward a native chooser request to the core or bypass existing business checks', () => {
    expect(() =>
      parseHostRequest({ method: 'sources.chooseFile', projectId }),
    ).toThrow('INVALID_REQUEST')
    expect(() => parseHostRequest({ ...internal, execute: 'shell' })).toThrow(
      'INVALID_REQUEST',
    )
    expect(() =>
      parseHostRequest({
        method: 'workspace.replaceCriteria',
        projectId,
        id: 'task-1',
        expectedVersion: 1,
        expectedCriteriaVersion: 0,
        expectedManualVersion: 0,
        criteria: [
          { id: 'a', description: 'one' },
          { id: 'a', description: 'two' },
        ],
      }),
    ).toThrow('INVALID_REQUEST')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'

const scope = { projectId: 'project-1', includeSourceText: false }
const save = { method: 'exports.save', ...scope }
const build = { method: 'exports.build', ...scope }
const invalidScopes = [
  { projectId: 'p' },
  { ...scope, projectId: '' },
  { ...scope, projectId: 'x'.repeat(257) },
  { ...scope, projectId: ' p' },
  { ...scope, projectId: null },
  { ...scope, includeSourceText: 'false' },
  { ...scope, includeSourceText: 0 },
  { ...scope, taskIds: [] },
  { ...scope, taskIds: ['t', 't'] },
  { ...scope, taskIds: Array.from({ length: 1001 }, (_, id) => String(id)) },
  { ...scope, taskIds: [''] },
  { ...scope, taskIds: ['x'.repeat(257)] },
  { ...scope, taskIds: ['t\0'] },
  { ...scope, taskIds: [1] },
  { ...scope, taskIds: 't' },
  { ...scope, path: '/private/export.json' },
  { ...scope, format: 'csv' },
  { ...scope, includeCredentials: true },
  { ...scope, sql: 'SELECT * FROM source_grants' },
  { ...scope, cursor: 'forged' },
]

describe('explicit export scope', () => {
  it('preserves UUIDs and ordinary s/u/digit IDs while rejecting whitespace and controls', () => {
    for (const projectId of [
      '3f09e6ce-1788-4c83-a85d-7d621f760ee4',
      'source-user-0123456789',
    ]) {
      expect(
        parseCoreRequest({
          ...save,
          projectId,
          taskIds: ['6e5f0e02-a8c2-4e66-9a10-3d9eb04a1234'],
        }).method,
      ).toBe('exports.save')
      expect(parseHostRequest({ ...build, projectId }).method).toBe(
        'exports.build',
      )
    }
    for (const projectId of [
      'has space',
      'tab\there',
      'line\nfeed',
      'carriage\rreturn',
      'nul\0here',
      'del\u007fhere',
    ]) {
      expect(() => parseCoreRequest({ ...save, projectId })).toThrow(
        'INVALID_REQUEST',
      )
      expect(() =>
        parseHostRequest({ ...build, taskIds: [projectId] }),
      ).toThrow('INVALID_REQUEST')
    }
  })

  it('accepts whole-project or selected-task export with an explicit body choice', () => {
    for (const input of [
      scope,
      { ...scope, includeSourceText: true },
      { ...scope, taskIds: ['t-1', 't-2'] },
      {
        ...scope,
        taskIds: Array.from({ length: 1000 }, (_, id) => String(id)),
      },
    ]) {
      expect(parseCoreRequest({ method: 'exports.save', ...input })).toEqual({
        method: 'exports.save',
        ...input,
      })
      expect(parseHostRequest({ method: 'exports.build', ...input })).toEqual({
        method: 'exports.build',
        ...input,
      })
    }
  })
  it.each(invalidScopes)(
    'rejects malformed or overbroad scope %# at both boundaries',
    (input) => {
      expect(() =>
        parseCoreRequest({ method: 'exports.save', ...input }),
      ).toThrow('INVALID_REQUEST')
      expect(() =>
        parseHostRequest({ method: 'exports.build', ...input }),
      ).toThrow('INVALID_REQUEST')
    },
  )
  it('keeps native save and internal bundle construction on opposite sides of the boundary', () => {
    expect(() => parseCoreRequest(build)).toThrow('INVALID_REQUEST')
    expect(() => parseHostRequest(save)).toThrow('INVALID_REQUEST')
    expect(() =>
      parseHostRequest({ ...build, path: '/tmp/export.json' }),
    ).toThrow('INVALID_REQUEST')
  })
  it('rejects internal build and invalid public scopes before dispatching native UI', async () => {
    const frame = { url: 'memo://app/index.html' }
    const renderer = { mainFrame: frame, isDestroyed: () => false }
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      data: { cancelled: true },
    }))
    const handler = createRequestHandler(() => renderer, frame.url, dispatch)
    const event = { sender: renderer, senderFrame: frame }
    for (const request of [
      build,
      ...invalidScopes.map((input) => ({ method: 'exports.save', ...input })),
    ])
      expect(await handler(event, request)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      })
    expect(dispatch).not.toHaveBeenCalled()
    expect(await handler(event, save, 'extra')).toEqual({
      ok: false,
      error: 'INVALID_REQUEST',
    })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects native save requests from a foreign window or child frame', async () => {
    const frame = { url: 'memo://app/index.html' }
    const renderer = { mainFrame: frame, isDestroyed: () => false }
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      data: { cancelled: true },
    }))
    const handler = createRequestHandler(() => renderer, frame.url, dispatch)
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: renderer, senderFrame: { url: frame.url } },
    ])
      expect(await handler(event, save)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

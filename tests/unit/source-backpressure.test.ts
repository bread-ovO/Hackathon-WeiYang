import { describe, expect, it, vi } from 'vitest'
import type { openStore } from '@memo/storage'
const read = vi.hoisted(() => vi.fn())
vi.mock('@memo/plugin-host', () => ({
  readLocalJsonl: read,
  LocalJsonlError: class extends Error {
    code = 'INVALID_JSONL'
  },
}))
import { createSourceHandler } from '../../apps/desktop/src/core/sources'
function fixture() {
  const grant = {
    id: 's',
    grantVersion: 2,
    path: '/isolated/fixture.jsonl',
    cursor: '{"offset":7}',
  }
  const sources = {
    getAuthorized: vi.fn(() => ({ ...grant })),
    receiveBatch: vi.fn(),
    recordError: vi.fn(),
    list: vi.fn(() => []),
    authorize: vi.fn(),
    revoke: vi.fn(),
  }
  const ingestion = { assertCanReceive: vi.fn() }
  read.mockReset().mockResolvedValue({ events: [], cursor: { offset: 8 } })
  return {
    sources,
    ingestion,
    handler: createSourceHandler({
      sources,
      ingestion,
    } as unknown as ReturnType<typeof openStore>),
  }
}
describe('local source ingestion pressure', () => {
  it.each([
    'INGESTION_QUEUE_LIMIT',
    'INGESTION_DATABASE_LIMIT',
    'INGESTION_DISK_LOW',
    'INGESTION_PROBE_UNAVAILABLE',
  ])('does not read or poison source health on %s', async (code) => {
    const f = fixture()
    f.ingestion.assertCanReceive.mockImplementation(() => {
      throw Error(code)
    })
    await expect(
      f.handler({ method: 'sources.sync', id: 's' }),
    ).rejects.toThrow(code)
    expect(read).not.toHaveBeenCalled()
    expect(f.sources.recordError).not.toHaveBeenCalled()
    expect(f.sources.receiveBatch).not.toHaveBeenCalled()
    f.ingestion.assertCanReceive.mockReset()
    await f.handler({ method: 'sources.sync', id: 's' })
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { offset: 7 } }),
    )
    expect(f.sources.receiveBatch).toHaveBeenCalledWith(
      's',
      2,
      [],
      JSON.stringify({ offset: 8 }),
      '{"offset":7}',
    )
  })
  it('does not mark a source unhealthy when transactional admission loses a quota race', async () => {
    const f = fixture()
    f.sources.receiveBatch.mockImplementation(() => {
      throw Error('INGESTION_QUEUE_LIMIT')
    })
    await expect(
      f.handler({ method: 'sources.sync', id: 's' }),
    ).rejects.toThrow('INGESTION_QUEUE_LIMIT')
    expect(f.sources.recordError).not.toHaveBeenCalled()
  })
  it('preflights new-file import before filesystem access or authorization', async () => {
    const f = fixture()
    f.ingestion.assertCanReceive.mockImplementation(() => {
      throw Error('INGESTION_DISK_LOW')
    })
    await expect(
      f.handler({
        method: 'sources.importFile',
        projectId: 'p',
        path: '/does-not-exist',
      }),
    ).rejects.toThrow('INGESTION_DISK_LOW')
    expect(f.sources.authorize).not.toHaveBeenCalled()
  })
  it('still records ordinary read errors', async () => {
    const f = fixture()
    read.mockRejectedValue(Error('private original detail'))
    await expect(
      f.handler({ method: 'sources.sync', id: 's' }),
    ).rejects.toThrow()
    expect(f.sources.recordError).toHaveBeenCalledWith('s', 2, 'IMPORT_FAILED')
  })
})

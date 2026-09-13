import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const runtime = vi.hoisted(() => ({
  status: vi.fn().mockResolvedValue(true),
  install: vi.fn(),
}))
vi.mock('../../apps/desktop/src/main/pet/runtime-store', () => ({
  createRuntimeStore: () => runtime,
}))
import { initializeBundledPet } from '../../apps/desktop/src/main/pet/bundled-demo'
const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
  vi.clearAllMocks()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bugu-bundled-pet-'))
  roots.push(root)
  const bundle = join(root, 'bundle'),
    data = join(root, 'data')
  await mkdir(bundle)
  await mkdir(data)
  await writeFile(
    join(bundle, 'demo.json'),
    JSON.stringify({ version: 1, entry: 'Haru.model3.json' }),
  )
  return { bundle, data }
}
it('initializes a fresh library once and does not resurrect a removed default', async () => {
  const { bundle, data } = await fixture()
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      data: { models: [], currentModelId: null },
    })
    .mockResolvedValueOnce({
      ok: true,
      data: { status: 'imported', model: { id: 'a'.repeat(64) } },
    })
    .mockResolvedValueOnce({ ok: true, data: {} })
  expect(await initializeBundledPet(bundle, data, { request })).toBe(true)
  expect(request.mock.calls.map((c) => c[0])).toEqual([
    'list',
    'import',
    'select',
  ])
  request.mockClear()
  expect(await initializeBundledPet(bundle, data, { request })).toBe(false)
  expect(request).not.toHaveBeenCalled()
})
it('keeps an existing library and deliberate null selection', async () => {
  const { bundle, data } = await fixture()
  const request = vi.fn().mockResolvedValue({
    ok: true,
    data: { models: [{ id: 'b'.repeat(64) }], currentModelId: null },
  })
  expect(await initializeBundledPet(bundle, data, { request })).toBe(false)
  expect(request).toHaveBeenCalledTimes(1)
})
it('ordinary packages perform no model work', async () => {
  const request = vi.fn()
  expect(
    await initializeBundledPet('/nonexistent-bugu-demo', '/unused', {
      request,
    }),
  ).toBe(false)
  expect(request).not.toHaveBeenCalled()
})

import { test, expect } from '@playwright/test'
import { prepareLifecycle, diagnostics } from './pet-lifecycle-fixture'

test('custom model loop frame rate in an isolated workspace', async ({}, testInfo) => {
  const directory = process.env.PET_BENCH_MODEL_DIRECTORY
  test.skip(!directory, 'Opt in with a local model asset directory; no user workspace is read')
  test.setTimeout(90000)
  const fixture = await prepareLifecycle(directory!, process.env.PET_BENCH_MODEL_ENTRY ?? 'seio-loop.model3.json')
  try {
    const { pet } = fixture
    await expect.poll(async () => (await diagnostics(pet)).targetFps).toBe(60)
    const start = await diagnostics(pet), at = Date.now()
    await pet.waitForTimeout(10000)
    const end = await diagnostics(pet)
    const fps = (end.frames - start.frames) * 1000 / (Date.now() - at)
    expect(end.error).toBeNull()
    expect(fps).toBeGreaterThanOrEqual(30)
    await testInfo.attach('model-fps.json', { body: JSON.stringify({fps, targetFps:end.targetFps}), contentType:'application/json' })
    console.log(JSON.stringify({fps, targetFps:end.targetFps}))
  } finally { await fixture.close() }
})

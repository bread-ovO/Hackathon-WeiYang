import { writeFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import {
  prepareLifecycle,
  lifecycleAssetsReady,
  diagnostics,
  contextCycle,
  showReady,
} from './pet-lifecycle-fixture'
test('Hiyori frame pacing, context restoration and renderer crash isolation', async ({}, testInfo) => {
  test.skip(
    !lifecycleAssetsReady,
    'Licensed local Hiyori/runtime absent; no download',
  )
  test.setTimeout(150000)
  const fixture = await prepareLifecycle()
  try {
    const { app, main, pet } = fixture
    await expect.poll(async () => (await diagnostics(pet)).targetFps).toBe(15)
    const start = await diagnostics(pet),
      startAt = Date.now()
    await pet.waitForTimeout(10000)
    const idle =
      ((await diagnostics(pet)).frames - start.frames) /
      ((Date.now() - startAt) / 1000)
    expect(idle).toBeGreaterThanOrEqual(12)
    expect(idle).toBeLessThanOrEqual(18)
    expect(
      (
        await main.evaluate(() =>
          window.memo.pet.speak({ text: '真实十秒帧率采样' }),
        )
      ).ok,
    ).toBe(true)
    await expect.poll(async () => (await diagnostics(pet)).targetFps).toBe(30)
    const activeStart = await diagnostics(pet),
      activeAt = Date.now()
    await pet.waitForTimeout(10000)
    const active =
      ((await diagnostics(pet)).frames - activeStart.frames) /
      ((Date.now() - activeAt) / 1000)
    expect(active).toBeGreaterThanOrEqual(24)
    expect(active).toBeLessThanOrEqual(34)
    await main.evaluate(() => window.memo.pet.dismissBubble())
    await contextCycle(pet)
    expect((await main.evaluate(() => window.memo.health())).ok).toBe(true)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith('memo-pet://app/'))!
        .webContents.forcefullyCrashRenderer(),
    )
    await expect
      .poll(async () => {
        const r = await main.evaluate(() => window.memo.pet.state())
        return r.ok ? r.data.display : true
      })
      .toBe(false)
    expect((await main.evaluate(() => window.memo.health())).ok).toBe(true)
    const recovered = await showReady(app, main),
      frames = (await diagnostics(recovered)).frames
    await expect
      .poll(async () => (await diagnostics(recovered)).frames)
      .toBeGreaterThan(frames)
    await writeFile(
      testInfo.outputPath('render-lifecycle.json'),
      JSON.stringify(
        {
          idleFps: idle,
          activeFps: active,
          contextRecovered: true,
          rendererRecovered: true,
        },
        null,
        2,
      ),
    )
    await testInfo.attach('render-lifecycle.json', {
      body: JSON.stringify({
        idleFps: idle,
        activeFps: active,
        contextRecovered: true,
        rendererRecovered: true,
      }),
      contentType: 'application/json',
    })
  } finally {
    await fixture.close()
  }
})

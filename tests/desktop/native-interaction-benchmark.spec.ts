import { test, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { prepareLifecycle, lifecycleAssetsReady } from './pet-lifecycle-fixture'
test('measure native entry and pet window response paths', async ({}, info) => {
  test.skip(!lifecycleAssetsReady, 'Licensed Hiyori fixture required')
  test.setTimeout(180000)
  const f = await prepareLifecycle()
  const samples: {
    restoreMs: number
    restoreCallMs: number
    framesMs: number
    healthMs: number
    petShowMs: number
    petCallMs: number
    petReadyMs: number
  }[] = []
  const frame = () =>
    f.main.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    )
  try {
    for (let i = 0; i < 30; i++) {
      await f.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.webContents.getURL().startsWith('memo://app/'))!
          .hide(),
      )
      let t = performance.now()
      // Same show/focus calls as trayHost.restoreWindow; excludes OS menu hit-testing.
      await f.app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith('memo://app/'),
        )!
        w.show()
        w.focus()
      })
      const restoreCallMs = performance.now() - t
      await frame()
      const restoreMs = performance.now() - t
      t = performance.now()
      expect((await f.main.evaluate(() => window.memo.health())).ok).toBe(true)
      const healthMs = performance.now() - t
      expect((await f.main.evaluate(() => window.memo.pet.hide())).ok).toBe(
        true,
      )
      t = performance.now()
      expect((await f.main.evaluate(() => window.memo.pet.show())).ok).toBe(
        true,
      )
      const petCallMs = performance.now() - t
      await expect
        .poll(async () => {
          const s = await f.main.evaluate(() => window.memo.pet.state())
          return s.ok && s.data.renderStatus === 'ready'
        })
        .toBe(true)
      const petShowMs = performance.now() - t
      samples.push({
        restoreMs,
        restoreCallMs,
        framesMs: restoreMs - restoreCallMs,
        healthMs,
        petShowMs,
        petCallMs,
        petReadyMs: petShowMs - petCallMs,
      })
    }
    const percentile = (v: number[], p: number) =>
      [...v].sort((a, b) => a - b)[Math.ceil(v.length * p) - 1]
    const summary = Object.fromEntries(
      [
        'restoreMs',
        'restoreCallMs',
        'framesMs',
        'healthMs',
        'petShowMs',
        'petCallMs',
        'petReadyMs',
      ].map((k) => [
        k,
        {
          p50: percentile(
            samples.map((s) => s[k as keyof typeof s]),
            0.5,
          ),
          p95: percentile(
            samples.map((s) => s[k as keyof typeof s]),
            0.95,
          ),
        },
      ]),
    )
    const report = {
      createdAt: new Date().toISOString(),
      environment: {
        os: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        memoryBytes: totalmem(),
        versions: await f.app.evaluate(() => process.versions),
      },
      scope:
        '30 same-run samples; isolated empty workspace/Hiyori; main restore is warm, pet.hide destroys its renderer and pet.show recreates it; restore includes Playwright IPC plus two frames, not OS tray click; health is typed bridge round-trip; petShow is hide/show to reported ready, not first-ever import',
      background:
        'Other app/model evaluation work may be running; not an idle-machine laboratory baseline',
      samples,
      summary,
    }
    await writeFile(
      info.outputPath('native-interaction.json'),
      JSON.stringify(report, null, 2),
    )
    await info.attach('native-interaction', {
      path: info.outputPath('native-interaction.json'),
      contentType: 'application/json',
    })
  } finally {
    await f.close()
  }
})

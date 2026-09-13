import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('default package auto-installs and renders Hiyori; removing it survives restart', async () => {
  test.skip(
    !existsSync(resolve('apps/desktop/out/bundled-pet/demo.json')),
    'Run package:dir or bundle-demo-pet.mjs to prepare default assets',
  )
  test.setTimeout(60000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-bundled-start-')),
  )
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = root
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () =>
    electron.launch({
      executablePath: require('electron'),
      args: [resolve('apps/desktop/out/main/index.js')],
      env,
    })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.memo.pet.state())
          return state.ok ? state.data.renderStatus : null
        },
        { timeout: 30000 },
      )
      .toBe('ready')
    const state = await page.evaluate(() => window.memo.pet.state())
    if (!state.ok) throw Error('PET_FAILED')
    expect(state.data.models).toHaveLength(1)
    expect(state.data.runtimeReady).toBe(true)
    expect(state.data.currentModelId).toBe(state.data.models[0]!.id)
    const pet = app.windows().find((w) => w.url().includes('pet.html'))!
    await expect
      .poll(() =>
        pet.evaluate(
          () =>
            (window as unknown as { __petRender: { frames: number } })
              .__petRender.frames,
        ),
      )
      .toBeGreaterThan(3)
    await pet.screenshot({ path: 'test-results/bundled-hiyori.png' })
    expect(
      (
        await page.evaluate(
          (id) => window.memo.pet.remove(id),
          state.data.models[0]!.id,
        )
      ).ok,
    ).toBe(true)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(async () => {
        const next = await page.evaluate(() => window.memo.pet.state())
        return next.ok ? next.data.models.length : -1
      })
      .toBe(0)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

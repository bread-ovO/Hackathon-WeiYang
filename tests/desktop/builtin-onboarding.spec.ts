import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('built-in demo works without a picker and is idempotent across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-onboarding-'))
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
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    await app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: () => {
          throw Error('NO_PICKER_EXPECTED')
        },
      })
    })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('region', { name: '预置来源' })).toContainText(
      '无需账号',
    )
    await page.getByRole('button', { name: '一键体验', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '刷新', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.memo.workspace.list()
          return r.ok ? r.data.tasks.length : -1
        }),
      )
      .toBe(2)
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(
      page.getByRole('button', { name: /整理开放平台的接入说明/ }),
    ).toBeVisible()
    const inspect = () =>
      page.evaluate(async () => {
        const p = await window.memo.plugins.list(),
          w = await window.memo.workspace.list()
        if (!p.ok || !w.ok) throw Error('UNAVAILABLE')
        return {
          plugins: p.data.plugins.length,
          events: p.data.plugins[0]?.eventCount,
          projects: w.data.projects.length,
          tasks: w.data.tasks.length,
        }
      })
    expect(await inspect()).toEqual({
      plugins: 1,
      events: 3,
      projects: 1,
      tasks: 2,
    })
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    expect(
      await page.evaluate(
        async () => (await window.memo.plugins.startDemo()).ok,
      ),
    ).toBe(true)
    expect(await inspect()).toEqual({
      plugins: 1,
      events: 3,
      projects: 1,
      tasks: 2,
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

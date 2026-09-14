import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(resolve('apps/desktop/package.json'))

test('release starts empty and cannot generate demo records', async ({}, info) => {
  test.skip(process.env.BUGU_RELEASE_TEST !== '1', 'Run after package:real with BUGU_RELEASE_TEST=1')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-release-')))
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  env.MEMO_TEST_USER_DATA = root
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    executablePath: require('electron'),
    // A release ignores the legacy demo flag as well as the renderer preference.
    args: [resolve('apps/desktop'), '--mode=demo'],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '跟进', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.memo.startupMode)).toBe('real')
    await expect(page.getByRole('button', { name: '新建第一件事', exact: true })).toBeVisible()
    for (const text of ['本地工作区', '保存在此设备', '示例空间', '示例体验']) {
      await expect(page.getByText(text, { exact: true })).toHaveCount(0)
    }
    await expect(page.getByLabel('数据模式')).toHaveCount(0)
    await expect(page.locator('.profile-name')).toHaveText('个人空间')

    const before = await page.evaluate(() => window.memo.workspace.list())
    if (!before.ok) throw Error(before.error)
    expect(before.data.projects).toHaveLength(0)
    expect(before.data.tasks).toHaveLength(0)

    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('button', { name: '一键体验', exact: true })).toHaveCount(0)
    await expect(page.getByText('体验不咕', { exact: true })).toHaveCount(0)
    for (const name of ['配置飞书', '配置 GitHub', '配置 Codex']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
    }
    const demo = await page.evaluate(() => window.memo.plugins.startDemo())
    expect(demo.ok).toBe(false)
    const after = await page.evaluate(() => window.memo.workspace.list())
    if (!after.ok) throw Error(after.error)
    expect(after.data.projects).toHaveLength(0)
    expect(after.data.tasks).toHaveLength(0)

    for (const width of [1140, 880]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/index.html'))!
        main.setSize(width, 780)
      }, width)
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveAttribute('aria-current', 'page')
      const geometry = await page.locator('.profile').evaluate((profile) => {
        const button = profile.querySelector('button')!.getBoundingClientRect()
        const icon = profile.querySelector('button svg')!.getBoundingClientRect()
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          centered: Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2) < 1,
        }
      })
      expect(geometry).toEqual({ overflow: false, centered: true })
      await page.screenshot({ path: info.outputPath(`settings-${width}.png`) })
      await page.getByRole('button', { name: /^跟进/ }).first().click()
      await page.screenshot({ path: info.outputPath(`workspace-${width}.png`) })
    }
    await page.reload()
    await expect(page.getByRole('button', { name: '新建第一件事', exact: true })).toBeVisible()
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

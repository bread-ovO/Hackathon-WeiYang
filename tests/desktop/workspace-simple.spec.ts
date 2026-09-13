import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('compact actions are centered, labeled and settings cards work at both sizes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-simple-ui-')),
    output = join(root, 'seed.cjs')
  await build({
    entryPoints: [resolve('tests/fixtures/delivery-ui-seed.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    tsconfig: resolve('tsconfig.json'),
  })
  execFileSync(require('electron'), [output, root], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: resolve('apps/desktop/node_modules'),
    },
    timeout: 30000,
  })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await expect(page.getByLabel('真实事项标题')).toHaveCount(0)
    await expect(page.getByLabel('业务状态筛选')).toHaveCount(0)
    for (const label of ['刷新', '导出', '新建事项', '筛选事项']) {
      const button = page.getByRole('button', { name: label, exact: true })
      await expect(button.locator('svg')).toHaveCount(1)
      const geometry = await button.evaluate((el) => {
        const b = el.getBoundingClientRect(),
          i = el.querySelector('svg')!.getBoundingClientRect()
        return {
          w: b.width,
          h: b.height,
          dx: Math.abs((b.left + b.right - i.left - i.right) / 2),
          dy: Math.abs((b.top + b.bottom - i.top - i.bottom) / 2),
        }
      })
      expect(geometry.w).toBe(32)
      expect(geometry.h).toBe(32)
      expect(geometry.dx).toBeLessThan(1)
      expect(geometry.dy).toBeLessThan(1)
    }
    await page.bringToFront()
    await expect(
      page.getByRole('button', { name: '刷新', exact: true }),
    ).toBeEnabled()
    await page.getByRole('button', { name: '刷新', exact: true }).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('.kumo-tooltip-popup')).toHaveText('刷新')
    await page.getByRole('button', { name: /提交登录修复.*已收录/ }).click()
    await expect(page.getByLabel('编辑事项标题')).not.toBeVisible()
    await page.screenshot({ path: '/tmp/bugu-simple-workspace-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(980, 760),
    )
    await expect(
      page.getByRole('region', { name: '事项列表' }),
    ).not.toBeVisible()
    await expect(page.getByRole('region', { name: '事项详情' })).toBeVisible()
    expect(
      await page
        .locator('.detail')
        .evaluate((el) =>
          Math.abs(el.clientWidth - el.parentElement!.clientWidth),
        ),
    ).toBeLessThan(2)
    await page.screenshot({ path: '/tmp/bugu-simple-workspace-narrow.png' })
    await page.getByRole('button', { name: '关闭详情' }).click()
    await expect(page.getByRole('region', { name: '事项列表' })).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(
      page.getByRole('switch', { name: '允许基于事项生成话语' }),
    ).toBeVisible()
    await expect(
      page.getByRole('switch', { name: '允许桌宠播音' }),
    ).toBeVisible()
    await expect(page.getByLabel('系统声音', { exact: true })).not.toBeVisible()
    await page.screenshot({ path: '/tmp/bugu-simple-settings-narrow.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1280, 860),
    )
    await page.screenshot({ path: '/tmp/bugu-simple-settings-wide.png' })
    expect(
      await page
        .locator('.settings-page')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

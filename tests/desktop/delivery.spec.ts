import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('delivery setup, ambiguous feedback and manual completion through the real bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-delivery-ui-')),
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
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page.getByRole('button', { name: /提交登录修复.*已收录/ }).click()
    let panel = page.getByRole('region', { name: '交付进展' })
    await panel.getByText('跟进 PR 提交与反馈', { exact: true }).click()
    await panel
      .getByLabel('交付目标链接')
      .fill('https://github.com/example/demo/issues/1')
    await panel.getByRole('button', { name: '确认两个条件并开始跟进' }).click()
    await expect(panel).toContainText('1 / 2')
    await expect(
      panel.getByRole('button', { name: '核对后确认完成' }),
    ).toHaveCount(0)
    await expect(
      panel
        .locator('details')
        .filter({ has: page.locator('summary', { hasText: '查看关联依据' }) }),
    ).not.toHaveAttribute('open', '')
    await page.screenshot({ path: '/tmp/bugu-delivery-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(980, 760),
    )
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/bugu-delivery-narrow.png' })
    const bounds = await panel.evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
    }))
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1)
    await panel.getByRole('button', { name: '确认已向约定对象反馈' }).click()
    await expect(panel).toContainText('2 / 2')
    await panel.getByRole('button', { name: '核对后确认完成' }).click()
    await expect(panel).toContainText('已由你确认完成')
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() =>
          window.memo.workspace.detail('demo', 'delivery'),
        )
        return r.ok && r.data.task.status
      })
      .toBe('completed')
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

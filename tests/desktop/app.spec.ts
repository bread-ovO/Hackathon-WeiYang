import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('packaged renderer connects to isolated SQLite core without exposing Node', async () => {
  const data = await mkdtemp(join(tmpdir(), 'memo-desktop-'))
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = data
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByText('本地核心已就绪')).toBeVisible({
      timeout: 15000,
    })
    expect(
      await page.evaluate(() => ({
        node: typeof (globalThis as unknown as { require: unknown }).require,
        keys: Object.keys(window.memo),
      })),
    ).toEqual({ node: 'undefined', keys: ['health', 'plugins', 'credentials', 'exports', 'sources', 'workspace'] })

    await expect(
      page.getByRole('heading', { name: '基础链路已连通' }),
    ).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-settings.png',
    })
    await expect(
      page.getByRole('button', { name: '设置', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    const reply = await page.evaluate(() => window.memo.health())
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.data.eventCount).toBe(0)
      expect(reply.data.schemaVersion).toBe(6)
    }
    // Terminate only our named child process and verify a different, healthy core replaces it.
    const oldPid = await app.evaluate(({ app }) => {
      const metric = app
        .getAppMetrics()
        .find((item) => item.name === 'Memo Core')
      if (!metric) throw new Error('CORE_METRIC_MISSING')
      process.kill(metric.pid, 'SIGTERM')
      return metric.pid
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ app }, pid) =>
            app
              .getAppMetrics()
              .some((item) => item.name === 'Memo Core' && item.pid !== pid),
          oldPid,
        ),
      )
      .toBe(true)
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    // External windows are denied even when requested by the trusted renderer.
    await page.evaluate(() => window.open('https://example.com'))
    expect(app.windows()).toHaveLength(1)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('button', { name: '即将支持' })).toHaveCount(4)
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-connections.png',
    })
    await page.getByRole('button', { name: /^跟进/ }).click()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-home.png',
    })
    await page.getByRole('button', { name: '手动标记完成' }).click()
    await expect(page.getByRole('status')).toContainText('已在示例中标记完成')
    // A manual decision must preserve unmet evidence conditions.
    await expect(page.getByText('尚未找到对应记录')).toBeVisible()
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(
      page.getByRole('button', { name: '手动标记完成' }),
    ).toBeVisible()
    await page.getByRole('button', { name: '关闭提示' }).click()
    await page.getByRole('button', { name: /来源记录\s*3/ }).click()
    await page.getByRole('button', { name: /修复 PR 已提交/ }).click()
    await expect(page.getByText(/PR #128/)).toBeVisible()
    await page.getByRole('button', { name: '等待反馈', exact: true }).click()
    await expect(page.locator('.task-row')).toHaveCount(2)
    await page.getByRole('button', { name: '全部', exact: true }).click()
    await page.getByRole('textbox', { name: '搜索事项' }).fill('没有这个事项')
    await expect(
      page.getByRole('heading', { name: '没有匹配的事项' }),
    ).toBeVisible()
    await page.getByRole('button', { name: '清除筛选' }).click()
    await page.getByRole('button', { name: '添加事项', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-dialog.png',
    })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(
      page.getByRole('button', { name: '添加事项', exact: true }),
    ).toBeFocused()
    await page.getByRole('button', { name: '添加事项', exact: true }).click()
    await page.getByLabel('需要跟进什么？').fill('设计回归样例')
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '添加事项', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: '设计回归样例' }),
    ).toBeVisible()
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await expect(page.locator('.task-row')).toHaveCount(0)
    await expect(
      page.getByRole('heading', { name: '你的跟进清单，从这里开始' }),
    ).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-empty.png',
    })
    const after = await page.evaluate(() => window.memo.health())
    expect(after.ok && after.data.eventCount === 0).toBe(true)
    await page.getByRole('button', { name: '示例体验', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    await expect(page.getByRole('region', { name: '事项详情' })).toBeVisible()
    await expect(
      page.getByRole('region', { name: '事项列表' }),
    ).not.toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-narrow.png',
    })
    await page.getByRole('button', { name: '关闭详情' }).click()
    await expect(page.getByRole('region', { name: '事项列表' })).toBeVisible()
    for (const [name, file] of [
      ['连接', 'connections'],
      ['设置', 'settings'],
    ] as const) {
      await page.getByRole('button', { name, exact: true }).click()
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/desktop-${file}-narrow.png`,
      })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
    }
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
test('task timeline paginates all manual changes while preserving unsaved drafts', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'bugu-timeline-'))
  const output = join(root, 'seed.cjs')
  await build({
    entryPoints: ['tests/fixtures/task-timeline-seed.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: output,
    external: ['better-sqlite3'],
  })
  execFileSync(requireDesktop('electron'), [output, root], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: resolve('apps/desktop/node_modules'),
    },
    timeout: 30000,
  })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    executablePath: requireDesktop('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page
      .getByRole('button')
      .filter({
        has: page.locator('.task-title', { hasText: '分页验收事项 45' }),
      })
      .click()
    const draft = page.getByLabel('编辑事项标题')
    await draft.fill('未保存的时间线验收草稿')
    const timeline = page.getByRole('region', {
      name: '事项时间线',
      exact: true,
    })
    await timeline
      .getByRole('button', { name: '查看事项时间线', exact: true })
      .click()
    await expect(timeline.locator('article')).toHaveCount(20)
    await expect(timeline).toContainText('虚构调整 45')
    await expect(timeline).toContainText('分页验收事项 44')
    await timeline
      .getByRole('button', { name: '加载更多变化', exact: true })
      .click()
    await expect(timeline.locator('article')).toHaveCount(40)
    await timeline
      .getByRole('button', { name: '加载更多变化', exact: true })
      .click()
    await expect(timeline.locator('article')).toHaveCount(46)
    for (let i = 1; i <= 45; i++)
      await expect(
        timeline.getByText(`依据：虚构调整 ${i}`, { exact: true }),
      ).toHaveCount(1)
    await expect(
      timeline.getByRole('button', { name: '加载更多变化' }),
    ).toHaveCount(0)
    await expect(draft).toHaveValue('未保存的时间线验收草稿')
    await timeline
      .getByRole('button', { name: '刷新时间线', exact: true })
      .click()
    await expect(timeline.locator('article')).toHaveCount(20)
    await expect(draft).toHaveValue('未保存的时间线验收草稿')
    const actual = await page.evaluate(() =>
      window.memo.workspace.detail('timeline-project', 'timeline-task'),
    )
    expect(actual.ok && actual.data.task.title).toBe('分页验收事项 45')
    await timeline.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/task-timeline-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    const change = timeline.locator('article > dl > div').first()
    const labelBounds = await change.locator('dt').boundingBox()
    const valueBounds = await change.locator('dd').boundingBox()
    expect(labelBounds).not.toBeNull()
    expect(valueBounds).not.toBeNull()
    expect(Math.abs(labelBounds!.x - valueBounds!.x)).toBeLessThanOrEqual(4)
    expect(
      valueBounds!.y - (labelBounds!.y + labelBounds!.height),
    ).toBeGreaterThanOrEqual(0)
    expect(
      valueBounds!.y - (labelBounds!.y + labelBounds!.height),
    ).toBeLessThanOrEqual(32)
    await page.screenshot({ path: 'test-results/task-timeline-narrow.png' })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

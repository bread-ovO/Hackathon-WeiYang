import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
async function launch(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  env.MEMO_TEST_USER_DATA = root
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop')],
    env,
  })
}
test('empty default, adding feedback, compact detail and keyboard navigation', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-interface-empty-'))
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('button', { name: '新建第一件事' }),
    ).toBeVisible()
    await expect(page.locator('.task-row')).toHaveCount(0)
    await page.getByRole('button', { name: '新建第一件事' }).click()
    await page.getByLabel('新项目名称').fill('我的项目')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(page.getByLabel('所属项目')).not.toHaveValue('')
    await page.getByLabel('真实事项标题').fill('整理本周的交付安排')
    await page.getByRole('button', { name: '添加事项', exact: true }).click()
    const row = page.locator('.real-task-row')
    await expect(row).toHaveClass(/task-arrived/)
    expect(
      await row.evaluate((el) => getComputedStyle(el).animationName),
    ).toContain('task-arrival-in')
    await expect(row).toContainText('刚加入')
    await expect(row).not.toContainText('未设截止')
    await expect(row).not.toContainText('已收录')
    const marker = await row.evaluate((el) => {
      const icon = el
        .querySelector('.task-status-icon')!
        .getBoundingClientRect()
      const title = el.querySelector('.task-title')!.getBoundingClientRect()
      return Math.abs(icon.y + icon.height / 2 - title.y - title.height / 2)
    })
    expect(marker).toBeLessThan(1)
    await row.click()
    const detail = page.getByRole('region', { name: '事项详情' })
    await expect(detail.getByLabel('事项来源')).toContainText('手动添加')
    await expect(detail.getByLabel('事项来源').locator('time')).toBeVisible()
    await expect(detail.getByLabel('编辑事项标题')).not.toBeVisible()
    await expect(
      detail.getByText('至少需要两个条件才能拆分。'),
    ).not.toBeVisible()
    await expect(detail.getByRole('region', { name: '交付进展' })).toHaveCount(
      0,
    )
    await expect(detail.getByText('当前已保存截止时间：')).not.toBeVisible()
    await detail.getByRole('button', { name: '编辑事项', exact: true }).click()
    await page.getByLabel('编辑事项标题').fill('保留未保存的标题草稿')
    await detail.getByRole('button', { name: '返回事项概览' }).click()
    await detail.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '关联与历史' }).click()
    await expect(
      detail.getByRole('region', { name: '事项时间线' }),
    ).toBeVisible()
    await detail.getByRole('button', { name: '编辑事项', exact: true }).click()
    await expect(page.getByLabel('编辑事项标题')).toHaveValue(
      '保留未保存的标题草稿',
    )
    await detail.getByRole('button', { name: '返回事项概览' }).click()
    for (const width of [1140, 880]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setSize(width, 780),
        width,
      )
      expect(
        await detail.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true)
      await page.screenshot({ path: info.outputPath(`detail-${width}.png`) })
    }
    await page.keyboard.press('Escape')
    await expect(detail).not.toBeVisible()
    await expect(row).toBeFocused()
    await expect(row).not.toHaveClass(/task-arrived/)
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await expect(row).not.toHaveClass(/task-arrived/)
    await page.reload()
    await expect(row).toHaveCount(1)
    await expect(row).not.toHaveClass(/task-arrived/)
    await page.screenshot({ path: info.outputPath('list.png') })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('AI provenance, confirmation and reduced motion keep their business meaning', async ({}, info) => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-interface-ai-'))
  const output = join(root, 'seed.cjs')
  await build({
    entryPoints: [resolve('tests/fixtures/task-interface-seed.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
  })
  execFileSync(require('electron'), [output, root], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: resolve('apps/desktop/node_modules'),
    },
  })
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const row = page.getByRole('button', { name: /补充登录过期的回归测试/ })
    await expect(row).toContainText('待确认')
    await expect(row).not.toHaveClass(/task-arrived/)
    await row.click()
    const detail = page.getByRole('region', { name: '事项详情' })
    await expect(detail.getByLabel('事项来源')).toContainText('AI 整理')
    await expect(detail.getByLabel('事项来源')).toContainText('产品讨论.jsonl')
    await expect(
      detail.getByRole('region', { name: 'AI 分析建议' }),
    ).toContainText('验证重新登录与页面刷新，再反馈测试结果。')
    await expect(detail.locator('blockquote')).not.toBeVisible()
    await detail.getByText('查看来源依据 · 1', { exact: true }).click()
    await expect(detail.locator('blockquote')).toContainText(
      '请补充登录过期的回归测试',
    )
    await detail.getByText('查看来源依据 · 1', { exact: true }).click()
    await page.screenshot({ path: info.outputPath('ai-detail.png') })
    await detail.getByRole('button', { name: '确认收录', exact: true }).click()
    await expect(detail.getByRole('region', { name: '收录确认' })).toHaveCount(
      0,
    )
    await expect(detail.getByLabel('手动状态')).toHaveValue('todo')
    await expect(detail.locator('.evidence-summary')).toContainText('尚未核验')
    await detail.getByRole('button', { name: '关闭详情' }).click()
    await expect(row).toHaveClass(/task-arrived/)
    expect(await row.evaluate((el) => getComputedStyle(el).animationName)).toBe(
      'none',
    )
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

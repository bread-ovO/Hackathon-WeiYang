import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('manual workspace persists tasks, versions and archive without fabricating evidence', async () => {
  const data = await mkdtemp(join(tmpdir(), 'bugu-workspace-'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = data
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
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page.getByLabel('新项目名称').fill('隔离项目')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('项目已创建。')
    await page.getByLabel('所属项目').selectOption({ label: '隔离项目' })
    await page.getByLabel('真实事项标题').fill('人工持久事项')
    await page.getByRole('button', { name: '添加事项', exact: true }).click()
    await page.getByRole('button', { name: /人工持久事项.*已收录/ }).click()
    await page.getByLabel('手动状态').selectOption('completed')
    await expect(page.getByRole('status')).toContainText('已保存到本地')
    await expect(
      page.getByText('证据：尚未核验', { exact: true }),
    ).toBeVisible()
    const snapshot = await page.evaluate(() => window.memo.workspace.list())
    if (!snapshot.ok) throw new Error('WORKSPACE_UNAVAILABLE')
    const task = snapshot.data.tasks[0]!
    await page.getByLabel('编辑事项标题').fill('已修改标题')
    await page.getByRole('button', { name: '保存标题', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '已修改标题', exact: true }),
    ).toBeVisible()
    expect(
      await page.evaluate(
        (t) =>
          window.memo.workspace.updateTask({
            id: t.id,
            projectId: t.projectId!,
            expectedVersion: t.version,
            expectedCriteriaVersion: t.criteriaVersion,
            expectedManualVersion: t.manualVersion,
            patch: { title: '过时覆盖' },
          }),
        task,
      ),
    ).toEqual({ ok: false, error: 'VERSION_CONFLICT' })
    await page.getByRole('button', { name: '归档事项', exact: true }).click()
    await expect(page.locator('.task-row')).toHaveCount(0)
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    await expect(page.locator('.task-row')).toHaveCount(1)
    await page.screenshot({ path: 'test-results/workspace-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    await page.screenshot({ path: 'test-results/workspace-narrow.png' })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    const after = await page.evaluate(() => window.memo.workspace.list())
    expect(after.ok && after.data.tasks[0]?.title).toBe('已修改标题')
    expect(after.ok && after.data.tasks[0]?.status).toBe('completed')
    expect(after.ok && after.data.tasks[0]?.archivedAt).toBeTruthy()
    expect(after.ok && after.data.tasks[0]?.evidenceStatus).toBe('unknown')
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})

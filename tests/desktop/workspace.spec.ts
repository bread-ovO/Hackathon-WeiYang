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
    const snapshot = await page.evaluate(() =>
      window.memo.workspace.list({ archive: 'all' }),
    )
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
    await page.getByLabel('截止时间（本机时区）').fill('2026-10-20T17:30')
    await page
      .getByRole('button', { name: '保存截止时间', exact: true })
      .click()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() =>
          window.memo.workspace.list({ archive: 'all' }),
        )
        return r.ok && r.data.tasks[0]?.dueAt !== null
      })
      .toBe(true)
    await page.getByRole('button', { name: '添加条件', exact: true }).click()
    await page.getByLabel('条件 1', { exact: true }).fill('提交正确仓库的 PR')
    await page.getByRole('button', { name: '保存条件', exact: true }).click()
    await expect(page.getByLabel('条件版本')).toHaveValue('1')
    await expect(page.getByLabel('条件 1', { exact: true })).toHaveValue(
      '提交正确仓库的 PR',
    )
    await page.getByLabel('条件 1', { exact: true }).fill('提交 PR 并反馈链接')
    await page.getByRole('button', { name: '保存条件', exact: true }).click()
    await expect(page.getByLabel('条件版本')).toHaveValue('2')
    await page.getByLabel('条件版本').selectOption('1')
    await expect(page.getByLabel('条件 1', { exact: true })).toHaveValue(
      '提交正确仓库的 PR',
    )
    await expect(page.getByLabel('条件 1', { exact: true })).toBeDisabled()
    await page.getByLabel('条件版本').selectOption('2')
    await expect(page.getByLabel('条件 1', { exact: true })).toHaveValue(
      '提交 PR 并反馈链接',
    )
    await page.screenshot({path:'test-results/criteria-wide.png'})
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(860,700))
    await page.screenshot({path:'test-results/criteria-narrow.png'})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
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
    const after = await page.evaluate(() =>
      window.memo.workspace.list({ archive: 'all' }),
    )
    expect(after.ok && after.data.tasks[0]?.title).toBe('已修改标题')
    expect(after.ok && after.data.tasks[0]?.status).toBe('completed')
    expect(after.ok && after.data.tasks[0]?.archivedAt).toBeTruthy()
    expect(after.ok && after.data.tasks[0]?.evidenceStatus).toBe('unknown')
    const seeded = await page.evaluate(async () => {
      const snapshot = await window.memo.workspace.list({ archive: 'all' })
      if (!snapshot.ok) return false
      const project = snapshot.data.projects[0]!
      for (let i = 0; i < 51; i++) {
        const r = await window.memo.workspace.createTask(
          project.id,
          `分页事项 ${i}`,
        )
        if (!r.ok) return false
      }
      return true
    })
    expect(seeded).toBe(true)
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await expect(page.locator('.task-row')).toHaveCount(50)
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await expect(page.locator('.task-row')).toHaveCount(51)
    await expect(
      page.getByRole('button', { name: '加载更多', exact: true }),
    ).toHaveCount(0)
    await page.getByLabel('业务状态筛选').selectOption('completed')
    await expect(page.locator('.task-row')).toHaveCount(0)
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    await expect(page.locator('.task-row')).toHaveCount(1)
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})

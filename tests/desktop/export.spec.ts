import { test, expect, _electron as electron } from '@playwright/test'
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('export saves a scoped snapshot with explicit body choice and cancellation without file access in renderer', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-export-desktop-')),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'user-data')
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
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    const { projectId, taskId } = await page.evaluate(async () => {
      const p = await window.memo.workspace.createProject('导出验收项目')
      if (!p.ok) throw new Error('PROJECT_FAILED')
      const projectId = p.data.projects[0]!.id
      const c = await window.memo.workspace.createTask(
        projectId,
        '导出归档事项',
      )
      if (!c.ok) throw new Error('TASK_FAILED')
      const t = c.data.tasks[0]!
      const u = await window.memo.workspace.updateTask({
        projectId,
        id: t.id,
        expectedVersion: t.version,
        expectedCriteriaVersion: t.criteriaVersion,
        expectedManualVersion: t.manualVersion,
        patch: { status: 'completed', archived: true },
      })
      if (!u.ok) throw new Error('UPDATE_FAILED')
      return { projectId, taskId: t.id }
    })
    const destination = join(root, 'export.json')
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showSaveDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      })
    }, destination)
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const modal = page.getByRole('dialog')
    await expect(
      modal.getByRole('heading', { name: '导出事项与证据' }),
    ).toBeVisible()
    await expect(modal.getByLabel('包含引用原文')).not.toBeChecked()
    await modal.getByRole('button', { name: '选择保存位置' }).click()
    await expect(modal.getByRole('status')).toHaveText(
      '已导出 1 条事项、0 条引用。',
    )
    const bundle = JSON.parse(await readFile(destination, 'utf8'))
    expect(bundle.schemaVersion).toBe(5)
    expect(bundle.referenceConflictAudit).toEqual([])
    expect(bundle.project.id).toBe(projectId)
    expect(bundle.sourceBodiesIncluded).toBe(false)
    expect(bundle.tasks).toHaveLength(1)
    expect(bundle.tasks[0]).toMatchObject({
      id: taskId,
      status: 'completed',
      evidenceStatus: 'unknown',
    })
    expect(bundle.tasks[0].archivedAt).not.toBeNull()
    expect(bundle.decisions.length).toBeGreaterThanOrEqual(2)
    expect(bundle.revisions.length).toBeGreaterThanOrEqual(2)
    expect(await readFile(destination, 'utf8')).not.toContain(root)
    await modal.getByLabel('包含引用原文').check()
    await modal.getByRole('button', { name: '选择保存位置' }).click()
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(destination, 'utf8')).sourceBodiesIncluded,
      )
      .toBe(true)
    await expect(
      modal.getByRole('button', { name: '选择保存位置' }),
    ).toBeEnabled()
    const before = await readFile(destination, 'utf8')
    await app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showSaveDialog', {
        configurable: true,
        value: async () => ({ canceled: true }),
      })
    })
    await modal.getByRole('button', { name: '选择保存位置' }).click()
    await expect(modal.getByRole('status')).toHaveText(
      '已取消保存，未生成文件。',
    )
    expect(await readFile(destination, 'utf8')).toBe(before)
    await page.screenshot({ path: 'test-results/export-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 620),
    )
    await page.screenshot({ path: 'test-results/export-narrow.png' })
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    )
    await page.keyboard.press('Escape')
    await expect(modal).not.toBeVisible()
    await expect(
      page.getByRole('button', { name: '导出', exact: true }),
    ).toBeFocused()
    await page.evaluate(
      (projectId) =>
        window.memo.workspace.createTask(projectId, '不应混入单项导出的事项'),
      projectId,
    )
    await page.getByRole('button', { name: '已归档', exact: true }).click()
    await page.getByRole('button', { name: /导出归档事项.*已收录/ }).click()
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showSaveDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      })
    }, destination)
    await page.getByRole('button', { name: '导出', exact: true }).click()
    await modal.getByLabel('导出范围').selectOption('selected')
    await modal.getByRole('button', { name: '选择保存位置' }).click()
    await expect(modal.getByRole('status')).toHaveText(
      '已导出 1 条事项、0 条引用。',
    )
    expect(
      JSON.parse(await readFile(destination, 'utf8')).tasks.map(
        (t: { id: string }) => t.id,
      ),
    ).toEqual([taskId])
    await modal.getByLabel('导出范围').selectOption('project')
    await modal.getByRole('button', { name: '选择保存位置' }).click()
    await expect(modal.getByRole('status')).toHaveText(
      '已导出 2 条事项、0 条引用。',
    )
    await modal.getByRole('button', { name: '关闭', exact: true }).click()
    // Host refuses a selected symlink, preserving its target. Public reply exposes only a fixed code.
    if (process.platform !== 'win32') {
      const target = join(root, 'keep.json'),
        link = join(root, 'link.json')
      await writeFile(target, '{"keep":true}')
      await symlink(target, link)
      await app.evaluate(({ dialog }, filePath) => {
        Object.defineProperty(dialog, 'showSaveDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePath }),
        })
      }, link)
      expect(
        await page.evaluate(
          (projectId) =>
            window.memo.exports.save({ projectId, includeSourceText: false }),
          projectId,
        ),
      ).toEqual({ ok: false, error: 'EXPORT_WRITE_FAILED' })
      expect(await readFile(target, 'utf8')).toBe('{"keep":true}')
    }
    expect(
      (await readdir(root)).filter((n) => n.startsWith('.bugu-export-')),
    ).toEqual([])
    // Invalid scope is rejected after a real selection, before any target write.
    await app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showSaveDialog', {
        configurable: true,
        value: () =>
          new Promise((resolve) => {
            ;(
              globalThis as unknown as { finishExportDialog: () => void }
            ).finishExportDialog = () => resolve({ canceled: true })
          }),
      })
    })
    await page.evaluate((projectId) => {
      ;(globalThis as unknown as { pendingExport: unknown }).pendingExport =
        window.memo.exports.save({ projectId, includeSourceText: false })
    }, projectId)
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            typeof (globalThis as unknown as { finishExportDialog: unknown })
              .finishExportDialog,
        ),
      )
      .toBe('function')
    expect(
      await page.evaluate(
        (projectId) =>
          window.memo.exports.save({ projectId, includeSourceText: false }),
        projectId,
      ),
    ).toEqual({ ok: false, error: 'CORE_UNAVAILABLE' })
    await app.evaluate(() =>
      (
        globalThis as unknown as { finishExportDialog: () => void }
      ).finishExportDialog(),
    )
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { pendingExport: unknown }).pendingExport,
      ),
    ).toEqual({ ok: true, data: { cancelled: true } })
    const absent = join(root, 'absent.json')
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showSaveDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePath }),
      })
    }, absent)
    expect(
      await page.evaluate(
        (projectId) =>
          window.memo.exports.save({
            projectId,
            taskIds: ['missing-task'],
            includeSourceText: false,
          }),
        projectId,
      ),
    ).toEqual({ ok: false, error: 'NOT_FOUND' })
    expect(await readdir(root)).not.toContain('absent.json')
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

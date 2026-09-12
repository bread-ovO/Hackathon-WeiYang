import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile, appendFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('selected JSONL import resumes, deduplicates and revokes without exposing filesystem paths', async () => {
  const data = await mkdtemp(join(tmpdir(), 'bugu-source-'))
  const file = join(data, 'fictional.jsonl')
  const row = (id: string, role: string) =>
    JSON.stringify({
      id,
      revision: '1',
      created_at: '2026-09-13T00:00:00Z',
      role,
      content: '合成导出，仅用于测试 ' + id,
    })
  await writeFile(
    file,
    row('1', 'user') + '\n' + row('2', 'assistant') + '\n' + row('3', 'tool'),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(data, 'profile')
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
    const project = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('导入测试')
      if (!r.ok) throw new Error('PROJECT_FAILED')
      return r.data.projects[0]!.id
    })
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      })
    }, file)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByLabel('导入项目').selectOption(project)
    await page
      .getByRole('button', { name: '选择 JSONL 文件', exact: true })
      .click()
    const panel = page.getByRole('region', { name: '本地导出导入' })
    await expect(panel).toContainText('已接收 2 条')
    const before = await page.evaluate(() => window.memo.sources.list())
    if (!before.ok) throw new Error('SOURCE_FAILED')
    const source = before.data.sources[0]!
    expect(JSON.stringify(source)).not.toContain(file)
    expect(Object.keys(source)).not.toContain('path')
    expect(Object.keys(source)).not.toContain('cursor')
    await appendFile(file, '\n')
    await panel.getByRole('button', { name: '继续同步', exact: true }).click()
    await expect(panel).toContainText('已接收 3 条')
    await panel.getByRole('button', { name: '继续同步', exact: true }).click()
    await expect(panel.getByRole('status')).toContainText('本批记录已接收')
    await expect(panel).toContainText('已接收 3 条')
    const tasks = await page.evaluate(() => window.memo.workspace.list())
    expect(tasks.ok && tasks.data.totalCount).toBe(0)
    await panel.getByRole('button', { name: '撤销授权', exact: true }).click()
    await expect(
      panel.getByRole('button', { name: '继续同步', exact: true }),
    ).toBeDisabled()
    expect(
      (await page.evaluate((id) => window.memo.sources.sync(id), source.id)).ok,
    ).toBe(false)
    await app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: true, filePaths: [] }),
      })
    })
    await panel
      .getByRole('button', { name: '选择 JSONL 文件', exact: true })
      .click()
    await expect(panel.getByRole('status')).toContainText('已取消')
    await app.evaluate(({ dialog }, path) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      })
    }, file)
    await panel
      .getByRole('button', { name: '选择 JSONL 文件', exact: true })
      .click()
    await expect(
      panel.getByRole('button', { name: '继续同步', exact: true }),
    ).toBeEnabled()
    await expect(panel).toContainText('已接收 3 条')
    if (process.platform !== 'win32') {
      const linked = join(data, 'linked.jsonl')
      await symlink(file, linked)
      await app.evaluate(({ dialog }, path) => {
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        })
      }, linked)
      expect(
        (
          await page.evaluate(
            (projectId) => window.memo.sources.chooseFile(projectId),
            project,
          )
        ).ok,
      ).toBe(false)
    }
    const after = await page.evaluate(() => window.memo.sources.list())
    expect(after.ok && after.data.sources).toHaveLength(1)
    expect(after.ok && after.data.sources[0]?.id).toBe(source.id)
    await page.screenshot({ path: 'test-results/source-import-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    await page.screenshot({ path: 'test-results/source-import-narrow.png' })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})

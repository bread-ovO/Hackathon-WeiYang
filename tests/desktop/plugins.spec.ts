import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { LOCAL_JSONL_MANIFEST_EXAMPLE } from '../../packages/plugin-host/src/manifest'
const require = createRequire(resolve('apps/desktop/package.json'))
test('plugin installation requires trial, preserves history and fences disabled imports', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-plugin-ui-'))),
    manifestPath = join(root, 'plugin.json'),
    file = join(root, 'events.jsonl')
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...LOCAL_JSONL_MANIFEST_EXAMPLE,
      displayName: '虚构来源插件',
    }),
  )
  await writeFile(
    file,
    JSON.stringify({
      id: 'sample',
      revision: '1',
      created_at: '2026-09-13T00:00:00Z',
      content: '隔离测试样例',
    }) + '\n',
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
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
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    const project = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('插件验收')
      if (!r.ok) throw Error('CREATE_FAILED')
      return r.data.projects[0]!.id
    })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    const choose = async (path: string | null) =>
      app.evaluate(({ dialog }, path) => {
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({
            canceled: path === null,
            filePaths: path ? [path] : [],
          }),
        })
      }, path)
    const panel = page.getByRole('region', { name: '声明式插件管理' })
    await choose(manifestPath)
    await panel.getByRole('button', { name: '安装插件', exact: true }).click()
    await expect(panel).toContainText('仅读取：events.jsonl')
    await page.getByLabel('插件收录项目').selectOption(project)
    const before = await page.evaluate(() => window.memo.health())
    expect(
      await page.evaluate(() => window.memo.plugins.activate('forged')),
    ).toEqual({ ok: false, error: 'PLUGIN_CONFLICT' })
    await choose(root)
    await panel.getByRole('button', { name: '选择目录并试运行' }).click()
    await expect(panel).toContainText('样例 1 条')
    expect(await page.evaluate(() => window.memo.health())).toEqual(before)
    await panel.getByRole('button', { name: '刷新插件', exact: true }).click()
    await expect(
      panel.getByRole('button', { name: '启用插件', exact: true }),
    ).toHaveCount(0)
    await panel.getByRole('button', { name: '选择目录并试运行' }).click()
    await expect(panel).toContainText('样例 1 条')
    await panel.getByRole('button', { name: '启用插件', exact: true }).click()
    await expect(panel).toContainText('已启用')
    await panel.getByRole('button', { name: '立即同步' }).click()
    await expect(panel).toContainText('已收录 1 条')
    const snapshot = await page.evaluate(() => window.memo.plugins.list())
    expect(JSON.stringify(snapshot)).not.toContain(root)
    expect(JSON.stringify(snapshot)).not.toContain('隔离测试样例')
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/plugins-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 620),
    )
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/plugins-narrow.png' })
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    )
    await panel.getByRole('button', { name: '停用', exact: true }).click()
    await expect(panel).toContainText('已停用')
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    app = await launch()
    page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '声明式插件管理' }),
    ).toContainText('已停用')
    const after = await page.evaluate(() => window.memo.health())
    await page
      .getByRole('region', { name: '声明式插件管理' })
      .getByRole('button', { name: '卸载', exact: true })
      .click()
    await page.getByRole('button', { name: '确认卸载', exact: true }).click()
    await expect(page.getByText('已卸载插件，已收录历史保留。')).toBeVisible()
    expect(await page.evaluate(() => window.memo.health())).toEqual(after)
    const installed = await page.evaluate(() => window.memo.plugins.list())
    expect(installed.ok && installed.data.plugins.length).toBe(0)
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

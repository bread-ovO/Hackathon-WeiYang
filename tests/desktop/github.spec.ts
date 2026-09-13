import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
// Seed only isolated observations; verify/connect transport is covered independently.
// Far-future persisted poll time prevents any external request on resume.
test('Github observation UI preserves pause schedule and never treats PR merge as task completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-github-ui-')),
    output = join(root, 'seed.cjs')
  await build({
    entryPoints: [resolve('tests/fixtures/github-ui-seed.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    tsconfig: resolve('tsconfig.json'),
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
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('button', { name: '配置 GitHub', exact: true }).click()
    const panel = page.getByRole('region', { name: 'GitHub仓库连接' })
    await expect(panel).toContainText('fictional-owner/fictional-repository')
    await expect(panel).toContainText('已暂停')
    await expect(
      panel.getByRole('button', { name: '验证并启用仓库' }),
    ).toBeDisabled()
    const before = await page.evaluate(() => window.memo.github.list())
    if (!before.ok) throw Error('LIST_FAILED')
    const connection = before.data.connections[0]!
    expect(JSON.stringify(connection)).not.toContain(root)
    expect(Object.keys(connection)).not.toContain('cursor')
    expect(Object.keys(connection)).not.toContain('token')
    await panel.getByRole('button', { name: '查看 PR 观察记录' }).click()
    const records = panel.getByRole('region', {
      name: 'PR观察记录 fictional-owner/fictional-repository',
    })
    await expect(records).toContainText('打开中')
    await expect(records).toContainText('已关闭')
    await expect(records).toContainText('已合并')
    await expect(records).toContainText('feature/fixture → main')
    await expect(records).toContainText('创建时间')
    await expect(records).toContainText('关闭时间')
    await expect(records).toContainText('合并时间')
    await expect(records).toContainText('不会自动完成事项')
    await panel.getByRole('button', { name: '恢复仓库采样' }).click()
    await expect(panel).toContainText('已启用')
    const resumed = await page.evaluate(() => window.memo.github.list())
    expect(resumed.ok && resumed.data.connections[0]!.nextPollAt).toBe(
      connection.nextPollAt,
    )
    expect(
      await page.evaluate((id) => window.memo.github.sync(id), connection.id),
    ).toEqual({ ok: false, error: 'GITHUB_NOT_DUE' })
    await panel.getByRole('button', { name: '暂停仓库采样' }).click()
    await expect(panel).toContainText('已暂停')
    await records.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/github-records-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    await page.screenshot({ path: 'test-results/github-records-narrow.png' })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await panel.getByRole('button', { name: '撤销仓库授权' }).click()
    await expect(panel).toContainText('已撤销')
    await expect(
      panel.getByRole('button', { name: '同步仓库', exact: true }),
    ).toBeDisabled()
    await records.getByRole('button', { name: '刷新观察记录' }).click()
    await expect(records).toContainText('已合并')
    const workspace = await page.evaluate(() => window.memo.workspace.list())
    expect(workspace.ok && workspace.data.totalCount).toBe(0)
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

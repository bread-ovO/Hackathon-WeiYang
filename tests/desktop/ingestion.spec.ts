import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test'
import { mkdtemp, writeFile, appendFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))

test('queue pressure preserves local import progress and budget across restart', async () => {
  await mkdir(resolve('docs/engineering/images'), { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'bugu-ingestion-'))
  const file = join(root, 'fictional.jsonl')
  const row = (id: string) =>
    JSON.stringify({
      id,
      revision: '1',
      role: 'user',
      created_at: '2026-09-13T00:00:00Z',
      content: `虚构预算记录 ${id}`,
    }) + '\n'
  await writeFile(file, row('first'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const launch = () =>
    electron.launch({
      executablePath: requireDesktop('electron'),
      args: [resolve('apps/desktop/out/main/index.js')],
      env,
    })
  let app: ElectronApplication | undefined
  try {
    app = await launch()
    let page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    expect(
      (await page.evaluate(() => window.memo.processing.configure(false))).ok,
    ).toBe(true)
    const projectId = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('预算验收')
      if (!r.ok) throw Error('PROJECT_FAILED')
      return r.data.projects[0]!.id
    })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    const budget = page.getByRole('region', { name: '收录预算' })
    await expect(budget.getByLabel('队列上限')).toBeEnabled()
    await budget.getByLabel('队列上限').fill('1')
    await budget.getByRole('button', { name: '保存收录预算' }).click()
    await expect(budget).toContainText('预算已保存')
    await app.evaluate(
      ({ dialog }, path) =>
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        }),
      file,
    )
    await page.getByLabel('导入项目').selectOption(projectId)
    await page
      .getByRole('button', { name: '选择 JSONL 文件', exact: true })
      .click()
    const sourcePanel = page.getByRole('region', { name: '本地导出导入' })
    await expect(sourcePanel).toContainText('已接收 1 条')
    const sources = await page.evaluate(() => window.memo.sources.list())
    if (!sources.ok) throw Error('SOURCE_FAILED')
    const source = sources.data.sources[0]!
    await appendFile(file, row('second'))
    const blocked = await page.evaluate(
      (id) => window.memo.sources.sync(id),
      source.id,
    )
    expect(blocked).toEqual({ ok: false, error: 'INGESTION_QUEUE_LIMIT' })
    const paused = await page.evaluate(() => window.memo.ingestion.status())
    expect(paused.ok && paused.data).toMatchObject({
      paused: true,
      reason: 'queue_limit',
      pendingCount: 1,
      limits: { maxQueuedJobs: 1 },
    })
    expect(JSON.stringify(paused)).not.toContain(root)
    const untouched = await page.evaluate(() => window.memo.sources.list())
    expect(untouched.ok && untouched.data.sources[0]).toMatchObject({
      eventCount: 1,
      lastSuccessAt: source.lastSuccessAt,
    })
    await budget.getByRole('button', { name: '刷新预算状态' }).click()
    await expect(budget).toContainText('新增收录已暂停')
    await page.screenshot({
      path: 'test-results/ingestion-paused.png',
    })
    await budget.getByLabel('队列上限').fill('2')
    await budget.getByRole('button', { name: '保存收录预算' }).click()
    await expect(budget).toContainText('预算已保存')
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.ingestion.status())
        return r.ok ? r.data.limits.maxQueuedJobs : null
      })
      .toBe(2)
    await budget.getByRole('button', { name: '刷新预算状态' }).click()
    await expect(budget).toContainText('预算允许继续收录')
    await page.screenshot({
      path: 'test-results/ingestion-resumed.png',
    })
    await sourcePanel
      .getByRole('button', { name: '继续同步', exact: true })
      .click()
    await expect(sourcePanel).toContainText('已接收 2 条')
    const health = await page.evaluate(() => window.memo.health())
    expect(health.ok && health.data).toMatchObject({
      eventCount: 2,
      jobCount: 2,
    })
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
    const resumed = await page.evaluate(() => window.memo.ingestion.status())
    expect(resumed.ok && resumed.data).toMatchObject({
      pendingCount: 2,
      limits: { maxQueuedJobs: 2 },
    })
    expect(
      (await page.evaluate(() => window.memo.processing.status())).ok,
    ).toBe(true)
    // Raising room permits a real replay from the saved EOF; no skipped or repeated event/job.
    expect(
      (
        await page.evaluate(() =>
          window.memo.ingestion.configure({ maxQueuedJobs: 3 }),
        )
      ).ok,
    ).toBe(true)
    expect(
      (await page.evaluate((id) => window.memo.sources.sync(id), source.id)).ok,
    ).toBe(true)
    const after = await page.evaluate(() => window.memo.health())
    expect(after.ok && after.data).toMatchObject({ eventCount: 2, jobCount: 2 })
  } finally {
    await app?.evaluate(({ app }) => app.quit()).catch(() => {})
    await app?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

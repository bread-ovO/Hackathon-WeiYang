import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))

test('source observation respects pause and restart without creating rule tasks', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'bugu-processing-'))
  const file = join(root, 'fictional.jsonl')
  const commitment = '我会提交虚构验收报告。'
  const row = (id: string, role: string, content: string, revision = '1') =>
    JSON.stringify({
      id,
      revision,
      created_at: '2026-09-13T00:00:00Z',
      role,
      content,
    }) + '\n'
  await writeFile(
    file,
    row('promise', 'user', commitment) +
      row('suggestion', 'assistant', '我会提交助手建议报告。') +
      row('hypothesis', 'user', '如果需要，我会提交假设报告。'),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
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
  const ready = async () => {
    const page = await app!.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    return page
  }
  const list = async (page: Page, projectId: string) => {
    const reply = await page.evaluate(
      (projectId) => window.memo.workspace.list({ projectId }),
      projectId,
    )
    if (!reply.ok) throw Error('LIST_FAILED')
    return reply.data
  }
  const status = async (page: Page) => {
    const reply = await page.evaluate(() => window.memo.processing.status())
    if (!reply.ok) throw Error('STATUS_FAILED')
    return reply.data
  }
  try {
    app = await launch()
    let page = await ready()
    const projectIds = await page.evaluate(async () => {
      const first = await window.memo.workspace.createProject('整理验收项目')
      const second = await window.memo.workspace.createProject('隔离验收项目')
      if (!first.ok || !second.ok) throw Error('PROJECT_FAILED')
      return {
        alpha: first.data.projects.find((p) => p.name === '整理验收项目')!.id,
        beta: second.data.projects.find((p) => p.name === '隔离验收项目')!.id,
      }
    })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.locator('#preset-processing > summary').click()
    await page
      .getByRole('button', { name: '导入本地记录', exact: true })
      .click()
    const processing = page.getByRole('region', { name: '后台整理' })
    await processing
      .getByRole('button', { name: '暂停整理', exact: true })
      .click()
    await expect(processing).toContainText('已暂停')
    await app.evaluate(
      ({ dialog }, path) =>
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        }),
      file,
    )
    await page.getByLabel('导入项目').selectOption(projectIds.alpha)
    await page
      .getByRole('button', { name: '选择 JSONL 文件', exact: true })
      .click()
    await expect(
      page.getByRole('region', { name: '本地导出导入' }),
    ).toContainText('已接收 3 条')
    // Observe more than one real scheduler interval; no virtual clock or consumer stub.
    for (let i = 0; i < 3; i++) {
      expect((await status(page)).enabled).toBe(false)
      expect((await list(page, projectIds.alpha)).totalCount).toBe(0)
      await page.waitForTimeout(600)
    }
    await processing.getByRole('button', { name: '刷新整理状态' }).click()
    await expect(processing).toContainText('待处理 3')
    await page.screenshot({ path: 'test-results/processing-paused.png' })
    const sources = await page.evaluate(() => window.memo.sources.list())
    if (!sources.ok) throw Error('SOURCE_FAILED')
    const sourceId = sources.data.sources[0]!.id
    await processing
      .getByRole('button', { name: '继续整理', exact: true })
      .click()
    await expect.poll(async () => (await status(page)).processedCount).toBe(3)
    // No configured model: source observation alone must never create tasks.
    expect((await list(page, projectIds.alpha)).totalCount).toBe(0)
    expect((await list(page, projectIds.beta)).totalCount).toBe(0)
    await expect
      .poll(
        async () => {
          const reply = await page.evaluate(() => window.memo.analysis.status())
          return reply.ok ? reply.data.error : null
        },
        { timeout: 20000 },
      )
      .toBe('MODEL_NOT_CONFIGURED')
    await processing
      .getByRole('button', { name: '暂停整理', exact: true })
      .click()
    await appendFile(file, row('follow-up', 'user', '请准备发布清单。'))
    expect(
      (await page.evaluate((id) => window.memo.sources.sync(id), sourceId)).ok,
    ).toBe(true)
    expect((await status(page)).enabled).toBe(false)
    await app.close()
    app = await launch()
    page = await ready()
    expect((await status(page)).enabled).toBe(false)
    expect((await status(page)).processedCount).toBe(3)
    expect((await list(page, projectIds.alpha)).totalCount).toBe(0)
    expect((await list(page, projectIds.beta)).totalCount).toBe(0)
    expect(
      (await page.evaluate(() => window.memo.processing.configure(true))).ok,
    ).toBe(true)
    await expect.poll(async () => (await status(page)).processedCount).toBe(4)
    expect((await list(page, projectIds.alpha)).totalCount).toBe(0)
    expect((await status(page)).candidateCount).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.quit()).catch(() => {})
    await app?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

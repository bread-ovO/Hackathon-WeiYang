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

test('local background processing preserves pause, citations, project scope and manual edits across revision and restart', async () => {
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
    const processing = page.getByRole('region', { name: '本地候选整理' })
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
    const initial = await list(page, projectIds.alpha)
    expect(initial.totalCount).toBe(1)
    const candidate = initial.tasks[0]!
    expect(candidate).toMatchObject({
      title: '提交虚构验收报告',
      admission: 'candidate',
      status: 'todo',
      evidenceStatus: 'unknown',
      dueAt: null,
    })
    expect((await list(page, projectIds.beta)).totalCount).toBe(0)
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^跟进/ })
      .click()
    await expect(
      page.getByRole('button', { name: '刷新', exact: true }),
    ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: '刷新整理结果', exact: true }),
    ).toHaveCount(0)
    // New source records appear without a manual reload or a notification bar.
    await appendFile(file, row('follow-up', 'user', '我会准备虚构发布清单。'))
    expect(
      (await page.evaluate((id) => window.memo.sources.sync(id), sourceId)).ok,
    ).toBe(true)
    const added = page.getByRole('button', {
      name: '准备虚构发布清单 · 待确认收录',
      exact: true,
    })
    await expect(added).toBeVisible({ timeout: 10000 })
    await expect(added).toHaveClass(/task-arrived/)
    await expect(page.getByText('有新的整理结果', { exact: true })).toHaveCount(
      0,
    )
    await page
      .getByRole('button')
      .filter({
        has: page.locator('.task-title', { hasText: candidate.title }),
      })
      .click()
    const evidence = page.getByRole('region', { name: '候选来源依据' })
    await evidence.locator('summary').click()
    await expect(evidence.locator('blockquote')).toHaveText(commitment)
    await page.screenshot({ path: 'test-results/processing-citation.png' })
    await page.getByRole('button', { name: '编辑事项', exact: true }).click()
    await page.getByLabel('编辑事项标题').fill('人工保留的标题')
    await page.getByRole('button', { name: '保存标题', exact: true }).click()
    await expect
      .poll(
        async () =>
          (await list(page, projectIds.alpha)).tasks.find(
            (task) => task.id === candidate.id,
          )!.title,
      )
      .toBe('人工保留的标题')
    const manual = (await list(page, projectIds.alpha)).tasks.find(
      (task) => task.id === candidate.id,
    )!
    await expect(
      page.getByRole('heading', { name: '人工保留的标题', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: '保存标题', exact: true }),
    ).toBeEnabled()
    await page.getByLabel('编辑事项标题').fill('尚未保存的标题草稿')
    expect(
      (await page.evaluate((id) => window.memo.sources.sync(id), sourceId)).ok,
    ).toBe(true)
    expect((await list(page, projectIds.alpha)).totalCount).toBe(2)
    await appendFile(
      file,
      row('promise', 'user', '我会提交修订后的报告。', '2') +
        row('while-editing', 'user', '我会提交虚构发布材料。'),
    )
    expect(
      (await page.evaluate((id) => window.memo.sources.sync(id), sourceId)).ok,
    ).toBe(true)
    await expect.poll(async () => (await status(page)).processedCount).toBe(6)
    const revised = await list(page, projectIds.alpha)
    expect(revised.totalCount).toBe(3)
    expect(
      revised.tasks.find((task) => task.id === candidate.id),
    ).toMatchObject({
      id: candidate.id,
      title: manual.title,
      version: manual.version,
      manualVersion: manual.manualVersion,
    })
    // Wait through a real UI poll: background activity must not overwrite an open draft.
    await page.waitForTimeout(5500)
    await expect(page.getByLabel('编辑事项标题')).toHaveValue(
      '尚未保存的标题草稿',
    )
    await expect(page.getByLabel('编辑事项标题')).toBeFocused()
    await expect(
      page.getByRole('button', { name: '保存标题', exact: true }),
    ).toBeEnabled()
    // Closing the editor applies queued results without any refresh button.
    await page.getByRole('button', { name: '关闭详情' }).click()
    const afterEditing = page.getByRole('button', {
      name: '提交虚构发布材料 · 待确认收录',
      exact: true,
    })
    await expect(afterEditing).toBeVisible({ timeout: 10000 })
    await expect(afterEditing).toHaveClass(/task-arrived/)
    await page
      .getByRole('button')
      .filter({
        has: page.locator('.task-title', { hasText: '人工保留的标题' }),
      })
      .click()
    await expect(
      page.getByRole('region', { name: '候选来源依据' }),
    ).toContainText('来源有后续修订')
    await page
      .getByRole('region', { name: '候选来源依据' })
      .locator('summary')
      .filter({ hasText: '查看待复核修订摘录' })
      .click()
    await expect(
      page.getByText('这是后续修订的摘录，尚未应用到事项，也不作为完成证据。'),
    ).toBeVisible()
    await page.screenshot({
      path: 'test-results/processing-revision-review.png',
    })
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    app = await launch()
    page = await ready()
    await expect.poll(async () => (await status(page)).processedCount).toBe(6)
    expect((await status(page)).enabled).toBe(true)
    expect((await list(page, projectIds.alpha)).tasks).toHaveLength(3)
    expect(
      (await list(page, projectIds.alpha)).tasks.find(
        (task) => task.id === candidate.id,
      ),
    ).toMatchObject({
      id: candidate.id,
      title: manual.title,
      version: manual.version,
    })
    expect((await list(page, projectIds.beta)).totalCount).toBe(0)
  } finally {
    await app?.evaluate(({ app }) => app.quit()).catch(() => {})
    await app?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

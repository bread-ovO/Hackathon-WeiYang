import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))

test('explicit source retraction invalidates citation without overwriting manual task or editor drafts', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'bugu-retraction-'))
  const file = join(root, 'fictional.jsonl')
  const row = (revision: string, operation: 'upsert' | 'retract') =>
    JSON.stringify({
      id: 'promise',
      revision,
      operation,
      role: 'user',
      created_at:
        revision === '1' ? '2026-09-13T00:00:00Z' : '2026-09-13T00:01:00Z',
      content: operation === 'upsert' ? '我会提交虚构撤回验收报告。' : '',
    }) + '\n'
  await writeFile(file, row('1', 'upsert'))
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
    const projectId = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('撤回验收')
      if (!r.ok) throw Error('PROJECT_FAILED')
      return r.data.projects[0]!.id
    })
    await app.evaluate(
      ({ dialog }, path) =>
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        }),
      file,
    )
    expect(
      (
        await page.evaluate(
          (id) => window.memo.sources.chooseFile(id),
          projectId,
        )
      ).ok,
    ).toBe(true)
    await expect
      .poll(async () => {
        const r = await page.evaluate(
          (id) => window.memo.workspace.list({ projectId: id }),
          projectId,
        )
        return r.ok ? r.data.totalCount : 0
      })
      .toBe(1)
    const candidate = await page.evaluate(async (projectId) => {
      const r = await window.memo.workspace.list({ projectId })
      if (!r.ok) throw Error('LIST_FAILED')
      return r.data.tasks[0]!
    }, projectId)
    const manual = await page.evaluate(
      async ({ projectId, candidate }) => {
        const r = await window.memo.workspace.updateTask({
          projectId,
          id: candidate.id,
          expectedVersion: candidate.version,
          expectedCriteriaVersion: candidate.criteriaVersion,
          expectedManualVersion: candidate.manualVersion,
          patch: {
            title: '人工确认的撤回事项',
            status: 'completed',
            admission: 'accepted',
          },
        })
        if (!r.ok) throw Error('MANUAL_FAILED')
        return r.data.tasks.find((t) => t.id === candidate.id)!
      },
      { projectId, candidate },
    )
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page
      .getByRole('button')
      .filter({ has: page.locator('.task-title', { hasText: manual.title }) })
      .click()
    const title = page.getByLabel('编辑事项标题')
    await title.fill('尚未保存的标题草稿')
    const due = page.getByLabel('截止时间（本机时区）')
    await due.fill('2026-10-01T10:00')
    const sources = await page.evaluate(() => window.memo.sources.list())
    if (!sources.ok) throw Error('SOURCE_FAILED')
    const sourceId = sources.data.sources[0]!.id
    expect(
      (await page.evaluate(() => window.memo.processing.configure(false))).ok,
    ).toBe(true)
    await appendFile(file, row('2', 'retract'))
    expect(
      (await page.evaluate((id) => window.memo.sources.sync(id), sourceId)).ok,
    ).toBe(true)
    const immediate = await page.evaluate(
      async ({ projectId, id }) => {
        const r = await window.memo.workspace.detail(projectId, id)
        if (!r.ok) throw Error('DETAIL_FAILED')
        return r.data.provenance
      },
      { projectId, id: candidate.id },
    )
    expect(immediate?.some((p) => p.referenceStatus === 'invalidated')).toBe(
      true,
    )
    expect(
      (await page.evaluate(() => window.memo.processing.configure(true))).ok,
    ).toBe(true)
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.processing.status())
        return r.ok ? r.data.processedCount : 0
      })
      .toBe(2)
    await page.getByRole('button', { name: '刷新依据', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '候选来源依据' }),
    ).toContainText('引用已失效')
    await expect(title).toHaveValue('尚未保存的标题草稿')
    await expect(due).toHaveValue('2026-10-01T10:00')
    const saved = await page.evaluate(
      async ({ projectId, id }) => {
        const r = await window.memo.workspace.detail(projectId, id)
        if (!r.ok) throw Error('DETAIL_FAILED')
        return r.data
      },
      { projectId, id: candidate.id },
    )
    expect(saved.task).toMatchObject({
      title: manual.title,
      status: 'completed',
      admission: 'accepted',
      version: manual.version,
      manualVersion: manual.manualVersion,
    })
    const evidence = page.getByRole('region', { name: '候选来源依据' })
    await evidence.locator('summary').first().click()
    await expect(evidence).toContainText('事项保留')
    await page.screenshot({ path: 'test-results/retraction-evidence-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    await page.screenshot({
      path: 'test-results/retraction-evidence-narrow.png',
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    // Revoking read authorization is a separate fact and must not erase explicit retraction.
    expect(
      (await page.evaluate((id) => window.memo.sources.revoke(id), sourceId))
        .ok,
    ).toBe(true)
    await page.getByRole('button', { name: '刷新依据', exact: true }).click()
    await expect(evidence).toContainText('引用已失效')
    await expect(evidence).toContainText('来源已停用')
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
    const restored = await page.evaluate(
      async ({ projectId, id }) => {
        const r = await window.memo.workspace.detail(projectId, id)
        if (!r.ok) throw Error('DETAIL_FAILED')
        return r.data
      },
      { projectId, id: candidate.id },
    )
    expect(restored.task).toEqual(saved.task)
    expect(
      restored.provenance?.some((p) => p.referenceStatus === 'invalidated'),
    ).toBe(true)
  } finally {
    await app?.evaluate(({ app }) => app.quit()).catch(() => {})
    await app?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

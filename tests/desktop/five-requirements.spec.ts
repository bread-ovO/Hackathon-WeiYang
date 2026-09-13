import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('Kimi import, deadline, filters and merge survive restart through the production bridge', async () => {
  test.setTimeout(60000)
  const dir = await mkdtemp(join(tmpdir(), 'bugu-five-ui-')),
    session = join(dir, 'kimi')
  await mkdir(session)
  await mkdir(join(session, 'unsupported'))
  await writeFile(
    join(session, 'unsupported', 'wire.jsonl'),
    '{"type":"metadata","protocol_version":"2.0"}\n',
  )
  await writeFile(
    join(session, 'wire.jsonl'),
    [
      { type: 'metadata', protocol_version: '1.10' },
      {
        timestamp: 1789428600,
        message: {
          type: 'TurnBegin',
          payload: { user_input: '我会明天下午5点前提交 Kimi 报告。' },
        },
      },
      {
        timestamp: 1789428601,
        message: { type: 'TextPart', payload: { text: '我会提交助手报告。' } },
      },
    ]
      .map((v) => JSON.stringify(v))
      .join('\n') + '\n',
  )
  await writeFile(
    join(session, 'context.jsonl'),
    '{"role":"user","content":"我会提交没有时间的报告。"}\n',
  )
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
    MEMO_TEST_USER_DATA: join(dir, 'profile'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
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
      const r = await window.memo.workspace.createProject('五项验收')
      if (!r.ok) throw Error('create')
      return r.data.projects[0]!.id
    })
    await app.evaluate(({ dialog }, dir) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [dir] }),
      })
    }, session)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('button', { name: '配置 Kimi', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Kimi 会话导入' })
    await panel.getByLabel('授权项目').selectOption(project)
    await panel
      .getByRole('button', { name: '授权会话目录', exact: true })
      .click()
    await expect(panel.getByRole('status')).toContainText(
      '发现 2 个会话文件，已收录 1 个，跳过 1 个',
    )
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.memo.workspace.list()
          return r.ok ? r.data.tasks.length : 0
        }),
      )
      .toBe(1)
    const original = await page.evaluate(async () => {
      const r = await window.memo.workspace.list()
      if (!r.ok) throw Error('list')
      return r.data.tasks[0]!
    })
    expect(original.dueAt).toBe('2026-09-15T17:00:00.000Z')
    const target = await page.evaluate(async (project) => {
      const r = await window.memo.workspace.createTask(project, '最终验收报告')
      if (!r.ok) throw Error('target')
      return r.data.tasks.find((t) => t.title === '最终验收报告')!
    }, project)
    await page.getByRole('button', { name: /^跟进/ }).click()
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    const detail = await page.evaluate(
      async ({ project, id }) => window.memo.workspace.detail(project, id),
      { project, id: original.id },
    )
    if (!detail.ok) throw Error('detail')
    await page
      .getByLabel('来源筛选')
      .selectOption(detail.data.provenance![0]!.sourceInstanceId)
    await expect(
      page.getByRole('button', { name: /提交 Kimi 报告/ }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: /最终验收报告.*已收录/ }),
    ).toHaveCount(0)
    await page.getByLabel('活跃度筛选').selectOption('quiet')
    await expect(
      page.getByRole('button', { name: /提交 Kimi 报告/ }),
    ).toHaveCount(0)
    await page.getByLabel('活跃度筛选').selectOption('')
    await page.getByRole('button', { name: /提交 Kimi 报告/ }).click()
    await page.getByText('合并重复事项', { exact: true }).click()
    await expect(page.getByLabel('合并到事项').locator('option')).toHaveCount(2)
    await page.getByLabel('合并到事项').selectOption(target.id)
    await page.getByRole('button', { name: '确认合并到此事项' }).click()
    await expect(
      page.getByRole('heading', { name: '最终验收报告', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText('合并来源与原始历史', { exact: true }),
    ).toBeVisible()
    await page.screenshot({ path: '/tmp/bugu-five-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => !w.isDestroyed())!
        .setSize(980, 760),
    )
    await page.screenshot({ path: '/tmp/bugu-five-narrow.png' })
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    )
    expect(overflow).toBe(false)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    const restored = await page.evaluate(
      async ({ project, id }) => window.memo.workspace.detail(project, id),
      { project, id: original.id },
    )
    expect(restored.ok && restored.data.merge?.mergedInto).toBe(target.id)
    const survivor = await page.evaluate(
      async ({ project, id }) => window.memo.workspace.detail(project, id),
      { project, id: target.id },
    )
    expect(survivor.ok && survivor.data.provenance?.[0]?.quote).toContain(
      'Kimi 报告',
    )
  } finally {
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})

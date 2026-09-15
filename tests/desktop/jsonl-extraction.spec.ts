import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { formatJsonl } from '../evals/extraction-format'
import type { Format, Message } from '../fixtures/extraction/corpus'
const require = createRequire(resolve('apps/desktop/package.json'))
async function launch(root: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop')],
    env,
  })
  const page = await app.firstWindow()
  await expect(
    page.getByRole('heading', { name: '跟进', exact: true }),
  ).toBeVisible()
  const projectId = await page.evaluate(async () => {
    const result = await window.memo.workspace.createProject('JSONL 提取验收')
    if (!result.ok) throw Error('PROJECT_FAILED')
    return result.data.projects[0]!.id
  })
  return { app, page, projectId }
}
async function importFromUi(
  app: ElectronApplication,
  page: Page,
  format: Format,
  projectId: string,
  file: string,
  directory: string,
) {
  await app.evaluate(
    ({ dialog }, path) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [path] }),
      })
    },
    format === 'generic' ? file : directory,
  )
  await page.getByRole('button', { name: '连接', exact: true }).click()
  if (format === 'generic') {
    await page
      .getByRole('button', { name: '导入本地记录', exact: true })
      .click()
    await page.getByLabel('导入项目').selectOption(projectId)
    await page
      .getByRole('button', { name: '选择 JSONL 文件', exact: true })
      .click()
  } else {
    const name = { codex: 'Codex', 'claude-code': 'Claude Code', kimi: 'Kimi' }[
      format
    ]
    await page
      .getByRole('button', { name: `配置 ${name}`, exact: true })
      .click()
    const panel = page.getByRole('region', {
      name: `${name} 会话导入`,
      exact: true,
    })
    await panel.getByLabel('授权项目').selectOption(projectId)
    await panel.getByText('高级选项', { exact: true }).click()
    await panel
      .getByRole('button', { name: '选择其他会话目录', exact: true })
      .click()
  }
  await expect
    .poll(async () => {
      const result = await page.evaluate(() => window.memo.sources.list())
      return result.ok
        ? result.data.sources.filter((source) => source.status !== 'error')
            .length
        : 0
    })
    .toBe(1)
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: /^跟进/ })
    .click()
}
const sourceMessages: Message[] = [
  { id: 'm1', role: 'user', text: '我会提交季度验收报告。' },
  { id: 'm2', role: 'assistant', text: '我会提交助手建议任务。' },
  { id: 'm3', role: 'user', text: '示例：我会提交示例中的任务。' },
  { id: 'm4', role: 'tool', text: '我会提交工具输出里的任务。' },
  { id: 'm5', role: 'user', text: '我会更新安装说明。' },
]
for (const format of ['generic', 'codex', 'claude-code', 'kimi'] as const) {
  test(`${format}: real model authorization to visible candidates, citations and incremental sync`, async ({}, info) => {
    test.skip(
      process.env.BUGU_EVAL_LIVE !== '1',
      'Explicit real-model E2E; never replaces the accuracy corpus.',
    )
    test.setTimeout(180000)
    const root = await mkdtemp(join(tmpdir(), `bugu-e2e-extraction-${format}-`))
    const directory = join(root, 'sessions')
    await mkdir(directory)
    const file = join(
      directory,
      format === 'kimi' ? 'wire.jsonl' : 'synthetic.jsonl',
    )
    const initial = formatJsonl(sourceMessages, format).content
    await writeFile(file, initial)
    const { app, page, projectId } = await launch(root)
    try {
      const configured = await page.evaluate(() =>
        window.memo.modelProvider.configure({
          provider: 'codex-cli',
          enabled: true,
          model: '',
          baseUrl: '',
          credentialId: '',
        }),
      )
      expect(configured.ok).toBe(true)
      await importFromUi(app, page, format, projectId, file, directory)
      const rows = page.locator('.real-task-row')
      await expect(rows).toHaveCount(2, { timeout: 90000 })
      await expect(
        page.getByRole('button', {
          name: /季度验收报告.*待确认收录/,
        }),
      ).toBeVisible()
      await expect(
        page.getByRole('button', {
          name: /安装说明.*待确认收录/,
        }),
      ).toBeVisible()
      await page
        .getByRole('button', {
          name: /季度验收报告.*待确认收录/,
        })
        .click()
      const detail = page.getByRole('region', { name: '事项详情' })
      await expect(detail.getByLabel('手动状态')).toHaveValue('todo')
      const provenance = detail.getByRole('region', { name: 'AI 分析建议' })
      await provenance.locator('summary').click()
      await expect(provenance.locator('blockquote')).toContainText(
        sourceMessages[0]!.text,
      )
      await detail.getByRole('button', { name: '关闭详情' }).click()
      const sourceId = await page.evaluate(async () => {
        const result = await window.memo.sources.list()
        if (!result.ok) throw Error('SOURCE_FAILED')
        return result.data.sources[0]!.id
      })
      const sync = () =>
        page.evaluate((id) => window.memo.sources.sync(id), sourceId)
      expect((await sync()).ok).toBe(true)
      await expect(rows).toHaveCount(2)
      // A partial JSONL tail must not be processed until its terminating newline arrives.
      const extended = formatJsonl(
        [
          ...sourceMessages,
          { id: 'm6', role: 'user', text: '我会补充支付接口文档。' },
        ],
        format,
      ).content
      const tail = extended.slice(initial.length)
      await appendFile(file, tail.slice(0, -1))
      expect((await sync()).ok).toBe(true)
      await expect(rows).toHaveCount(2)
      if (format === 'generic') {
        await page
          .getByRole('button', { name: /季度验收报告.*待确认收录/ })
          .click()
        await page
          .getByRole('button', { name: '编辑事项', exact: true })
          .click()
        await page.getByLabel('编辑事项标题').fill('人工保留的标题')
        await page
          .getByRole('button', { name: '保存标题', exact: true })
          .click()
        await expect(
          page.getByRole('heading', { name: '人工保留的标题', exact: true }),
        ).toBeVisible()
        await page.getByLabel('编辑事项标题').fill('尚未保存的标题草稿')
      }
      await appendFile(file, '\n')
      expect((await sync()).ok).toBe(true)
      if (format === 'generic') {
        await expect
          .poll(
            async () => {
              const reply = await page.evaluate(
                (projectId) => window.memo.workspace.list({ projectId }),
                projectId,
              )
              return reply.ok ? reply.data.totalCount : 0
            },
            { timeout: 90000 },
          )
          .toBe(3)
        await expect(page.getByLabel('编辑事项标题')).toHaveValue(
          '尚未保存的标题草稿',
        )
        await expect(page.getByLabel('编辑事项标题')).toBeFocused()
        await page.getByRole('button', { name: '关闭详情' }).click()
        await expect(
          page.getByRole('button', { name: /人工保留的标题.*待确认收录/ }),
        ).toBeVisible()
      }
      await expect(rows).toHaveCount(3, { timeout: 90000 })
      await expect(
        page.getByRole('button', {
          name: /支付接口文档.*待确认收录/,
        }),
      ).toHaveClass(/task-arrived/)
      expect((await sync()).ok).toBe(true)
      await page.reload()
      await expect(rows).toHaveCount(3)
      await page.screenshot({
        path: info.outputPath(`${format}-candidates.png`),
      })
    } finally {
      if (info.status !== info.expectedStatus) {
        const diagnostic = await page
          .evaluate(async () => ({
            analysis: await window.memo.analysis.status(),
            processing: await window.memo.processing.status(),
            sources: await window.memo.sources.list(),
          }))
          .catch(() => null)
        await info.attach('synthetic-analysis-status', {
          body: JSON.stringify(diagnostic, null, 2),
          contentType: 'application/json',
        })
      }
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test('live Codex: an imperative JSONL request becomes a candidate through automatic analysis', async ({}, info) => {
  test.skip(
    process.env.BUGU_EVAL_LIVE !== '1',
    'Explicit live provider run only; never counted as a model accuracy score.',
  )
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'bugu-e2e-extraction-live-'))
  const file = join(root, 'live-synthetic.jsonl')
  const request = '请修复登录白屏，并针对这个修复补回归测试。'
  await writeFile(
    file,
    formatJsonl([{ id: 'm1', role: 'user', text: request }], 'generic').content,
  )
  const { app, page, projectId } = await launch(root)
  try {
    const configured = await page.evaluate(() =>
      window.memo.modelProvider.configure({
        provider: 'codex-cli',
        enabled: true,
        model: '',
        baseUrl: '',
        credentialId: '',
      }),
    )
    expect(configured.ok).toBe(true)
    await importFromUi(app, page, 'generic', projectId, file, root)
    const rows = page.locator('.real-task-row')
    await expect(rows).toHaveCount(1, { timeout: 100000 })
    await expect(rows).toContainText('白屏')
    await expect(rows).toContainText('待确认')
    await rows.click()
    const detail = page.getByRole('region', { name: '事项详情' })
    await expect(detail.getByLabel('事项来源')).toContainText('AI 整理')
    await expect(detail.getByLabel('手动状态')).toHaveValue('todo')
    const evidence = detail.getByRole('region', { name: 'AI 分析建议' })
    await evidence.locator('summary').click()
    await expect(evidence.locator('blockquote')).toContainText('登录白屏')
    await page.screenshot({ path: info.outputPath('live-model-candidate.png') })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

// This path stays offline and proves that the removed rule chain cannot create tasks.
test('without a configured model, imported commitments never become rule candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-e2e-no-rules-'))
  const file = join(root, 'synthetic.jsonl')
  await writeFile(file, formatJsonl(sourceMessages, 'generic').content)
  const { app, page, projectId } = await launch(root)
  try {
    await importFromUi(app, page, 'generic', projectId, file, root)
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.processing.status())
        return r.ok ? r.data.processedCount : 0
      })
      .toBe(5)
    await expect
      .poll(
        async () => {
          const r = await page.evaluate(() => window.memo.analysis.status())
          return r.ok ? r.data.error : null
        },
        { timeout: 30000 },
      )
      .toBe('MODEL_NOT_CONFIGURED')
    await expect(page.locator('.real-task-row')).toHaveCount(0)
    await page.reload()
    await expect(page.locator('.real-task-row')).toHaveCount(0)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

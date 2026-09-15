import { test, expect, _electron as electron } from '@playwright/test'
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  rm,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('native Codex capture to candidate, source error isolation, context preview and grounded draft', async ({}, info) => {
  test.skip(
    process.env.BUGU_EVAL_LIVE !== '1',
    'Opt-in real model with synthetic native-client capture',
  )
  test.setTimeout(180000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-ten-e2e-')))
  const directory = join(root, 'sessions')
  await mkdir(directory)
  await copyFile(
    'tests/fixtures/codex-native/session.jsonl',
    join(directory, 'native.jsonl'),
  )
  await writeFile(
    join(directory, 'broken.jsonl'),
    '{"type":"future_version"}\n',
  )
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
    MEMO_TEST_USER_DATA: join(root, 'profile'),
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop')],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    const projectId = await page.evaluate(async () => {
      const p = await window.memo.workspace.createProject('会话验收项目')
      if (!p.ok) throw Error('PROJECT_FAILED')
      return p.data.projects[0]!.id
    })
    await app.evaluate(
      ({ dialog }, path) =>
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        }),
      directory,
    )
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('button', { name: '配置 Codex', exact: true }).click()
    const panel = page.getByRole('region', {
      name: 'Codex 会话导入',
      exact: true,
    })
    await panel.getByLabel('授权项目').selectOption(projectId)
    await panel.getByText('高级选项', { exact: true }).click()
    await panel
      .getByRole('button', { name: '选择其他会话目录', exact: true })
      .click()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.sources.list())
        return r.ok
          ? r.data.sources.filter((s) => s.status === 'error').length
          : 0
      })
      .toBe(1)
    expect(
      (
        await page.evaluate(() =>
          window.memo.modelProvider.configure({
            provider: 'codex-cli',
            enabled: true,
            baseUrl: '',
            model: '',
            credentialId: '',
          }),
        )
      ).ok,
    ).toBe(true)
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^跟进/ })
      .click()
    await expect
      .poll(
        async () => {
          const r = await page.evaluate(() => window.memo.analysis.status())
          return r.ok && r.data.state === 'ready'
        },
        { timeout: 90000 },
      )
      .toBe(true)
    const analysis = await page.evaluate(() => window.memo.analysis.status())
    await info.attach('native-analysis', {
      body: JSON.stringify(analysis, null, 2),
      contentType: 'application/json',
    })
    await expect(page.locator('.real-task-row')).toHaveCount(1, {
      timeout: 90000,
    })
    await page
      .getByRole('button', { name: /BUGU.*测试验收报告.*待确认收录/ })
      .click()
    const detail = page.getByRole('region', { name: '事项详情' })
    await expect(
      detail.getByText(/等待.*完成|整理.*报告/).first(),
    ).toBeVisible()
    const source = await page.evaluate(() => window.memo.sources.list())
    expect(
      source.ok &&
        source.data.sources.some(
          (s) => s.status !== 'error' && s.eventCount === 4,
        ),
    ).toBe(true)
    const model = await page.evaluate(() => window.memo.modelProvider.status())
    expect(
      model.ok &&
        model.data.lastRequest?.messages.some((m) =>
          m.content.includes('测试验收报告'),
        ),
    ).toBe(true)
    // Read-only diagnostic preview must never include native tool output as a user request.
    expect(
      model.ok &&
        model.data.lastRequest?.messages.some((m) =>
          m.content.includes('"role":"tool"'),
        ),
    ).toBe(false)
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath('codex-candidate.png'),
    })
    // Close details and disable inference, then create/recap a manual task via real UI.
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'AI 聊天', exact: true }).click()
    await page.getByRole('button', { name: '模型设置', exact: true }).click()
    await page.getByText('最近调用的上下文', { exact: true }).click()
    await expect(
      page.getByText('本机 CLI 的已授权模型服务', { exact: false }),
    ).toBeVisible()
    const toggle = page.getByRole('switch', {
      name: '允许使用此服务分析所选会话',
    })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.modelProvider.status())
        return r.ok && r.data.config.enabled
      })
      .toBe(false)
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath('model-preview.png'),
    })
    await page
      .getByRole('button', { name: '关闭模型设置', exact: true })
      .click()
    expect(
      (
        await page.evaluate(
          (id) => window.memo.workspace.createTask(id, '人工验收记录'),
          projectId,
        )
      ).ok,
    ).toBe(true)
    await page.getByRole('button', { name: 'AI 聊天', exact: true }).click()
    await page.getByLabel('聊天项目').selectOption(projectId)
    await page.getByLabel('生成草稿').click()
    await page
      .getByRole('button', { name: '项目反馈草稿', exact: true })
      .click()
    await expect(page.getByLabel('编辑草稿')).toBeVisible()
    await expect(page.getByLabel('编辑草稿')).toHaveValue(/人工验收记录/)
    await expect(page.getByLabel('编辑草稿')).not.toHaveValue(/测试验收报告/) // unconfirmed candidates excluded
    await page.screenshot({
      animations: 'disabled',
      path: info.outputPath('draft.png'),
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

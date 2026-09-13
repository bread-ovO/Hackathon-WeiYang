import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
test('Feishu explicit reply becomes a human-confirmed plan change and preserves editor drafts', async () => {
  test.setTimeout(90000)
  const root = await realpath(
      await mkdtemp(join(tmpdir(), 'bugu-plan-change-')),
    ),
    profile = join(root, 'profile'),
    fixture = join(root, 'network.cjs'),
    token = 'fictional-desktop-feishu-token',
    tokenFile = join(root, 'token.txt')
  await writeFile(tokenFile, token + '\n')
  await build({
    entryPoints: [resolve('tests/fixtures/plan-change-network.ts')],
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => v[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = profile
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
    await app.evaluate(
      async (_, { fixture, token }) => {
        const { createRequire } = process.getBuiltinModule('module')
        createRequire(fixture)(fixture).install(token)
      },
      { fixture, token },
    )
    const projectId = await page.evaluate(async () => {
      const result =
        await window.memo.workspace.createProject('飞书真实配置验收')
      if (!result.ok) throw Error('PROJECT_FAILED')
      return result.data.projects[0]!.id
    })
    const vault = await page.evaluate(() => window.memo.credentials.list())
    expect(vault.ok).toBe(true)
    test.skip(
      !vault.ok || !vault.data.encryptionAvailable,
      'Native credential encryption unavailable; do not fake vault success',
    )
    await app.evaluate(
      ({ dialog }, file) =>
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [file] }),
        }),
      tokenFile,
    )
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-credentials > summary').click()
    await page.getByLabel('凭据名称').fill('合成 飞书 凭据')
    await page.getByLabel('凭据授权域名').fill('open.feishu.cn')
    await page.getByRole('button', { name: '导入凭据文件' }).click()
    await expect(page.getByText('凭据已加密保存，尚未绑定连接。')).toBeVisible()
    const credentials = await page.evaluate(() =>
      window.memo.credentials.list(),
    )
    if (!credentials.ok) throw Error('VAULT_FAILED')
    const credentialId = credentials.data.credentials[0]!.id
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('button', { name: '配置飞书', exact: true }).click()
    const panel = page.getByRole('region', { name: '飞书会话连接' })
    await panel.getByLabel('飞书项目').selectOption(projectId)
    await panel.getByLabel('飞书会话ID').fill('oc_desktop')
    const historyStart = new Date(Date.now() - 3600000)
    historyStart.setMilliseconds(0)
    const localStart = new Date(
      historyStart.getTime() - historyStart.getTimezoneOffset() * 60000,
    )
      .toISOString()
      .slice(0, 19)
    await panel.getByLabel('飞书历史起点').fill(localStart)
    await panel.getByLabel('飞书读取凭据').selectOption(credentialId)
    await panel.getByRole('button', { name: '验证并启用会话' }).click()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.feishu.list())
        return r.ok ? r.data.connections.length : 0
      })
      .toBe(1)
    await expect
      .poll(
        async () => {
          const r = await page.evaluate(() => window.memo.feishu.list())
          return r.ok ? r.data.connections[0]?.eventCount : 0
        },
        { timeout: 30000 },
      )
      .toBe(2)
    let targetId = ''
    await expect
      .poll(
        async () => {
          const tasks = await page.evaluate(
            (projectId) => window.memo.workspace.list({ projectId }),
            projectId,
          )
          if (!tasks.ok || !tasks.data.tasks.length) return 0
          targetId = tasks.data.tasks[0]!.id
          const result = await page.evaluate(
            ({ projectId, taskId }) =>
              window.memo.workspace.planChanges({ projectId, taskId }),
            { projectId, taskId: targetId },
          )
          return result.ok ? result.data.proposals.length : 0
        },
        { timeout: 30000 },
      )
      .toBe(1)
    await page.getByRole('button', { name: /^跟进/ }).click()
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByText('完成周报验收', { exact: true }).click()
    await page.getByText('关联、改期与历史', { exact: true }).click()
    const detail = page.getByRole('region', { name: '事项详情' })
    const plans = detail.getByRole('region', { name: '计划变更建议' })
    await expect(
      plans.getByText('截止时间改为 2026-09-20T18:00:00+08:00', {
        exact: true,
      }),
    ).toBeVisible()
    await detail.getByText('编辑事项与完成条件',{exact:true}).click()
    await detail.getByLabel('编辑事项标题').fill('尚未保存的改期草稿')
    await detail.getByLabel('截止时间（本机时区）').fill('2026-10-01T12:00')
    await detail.getByRole('button', { name: '添加条件', exact: true }).click()
    await detail
      .getByLabel('条件 1', { exact: true })
      .fill('尚未保存的条件草稿')
    await plans.getByRole('button', { name: '刷新计划建议' }).click()
    await plans.getByRole('button', { name: '核实并改期' }).click()
    await plans.getByLabel('改期确认理由').fill('已核实原始明确回复')
    await plans.getByRole('button', { name: '确认应用改期' }).click()
    await expect(plans.getByText('已人工应用', { exact: true })).toBeVisible()
    await expect(detail.getByLabel('编辑事项标题')).toHaveValue(
      '尚未保存的改期草稿',
    )
    await expect(detail.getByLabel('截止时间（本机时区）')).toHaveValue(
      '2026-10-01T12:00',
    )
    await expect(detail.getByLabel('条件 1', { exact: true })).toHaveValue(
      '尚未保存的条件草稿',
    )
    const saved = await page.evaluate(
      ({ projectId, id }) => window.memo.workspace.detail(projectId, id),
      { projectId, id: targetId },
    )
    expect(saved.ok && saved.data.task.dueAt).toBe('2026-09-20T10:00:00.000Z')
    expect(saved.ok && saved.data.task.title).not.toBe('尚未保存的改期草稿')
    await plans.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/plan-change-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(900, 720),
    )
    await plans.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/plan-change-narrow.png' })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

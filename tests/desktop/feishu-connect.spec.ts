import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
test('飞书 form verifies scope using vault and actual transport, persists paginated messages and human-only candidates and fences credential removal', async () => {
  test.setTimeout(90000)
  const root = await realpath(
      await mkdtemp(join(tmpdir(), 'bugu-feishu-connect-')),
    ),
    profile = join(root, 'profile'),
    fixture = join(root, 'network.cjs'),
    token = 'fictional-desktop-feishu-token',
    tokenFile = join(root, 'token.txt')
  await writeFile(tokenFile, token + '\n')
  await build({
    entryPoints: [resolve('tests/fixtures/feishu-network.ts')],
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
    await panel.getByLabel('飞书历史起点').fill(localStart.replace(/:00$/, ''))
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
    await panel.getByRole('button', { name: '刷新飞书连接' }).click()
    await panel.getByRole('button', { name: '查看已收录记录' }).click()
    await expect(
      panel.getByText('我会完成飞书连接测试', { exact: true }),
    ).toBeVisible()
    await expect(
      panel.getByText('我会完成机器人示例', { exact: true }),
    ).toBeVisible()
    const snapshot = await page.evaluate(() => window.memo.feishu.list())
    if (!snapshot.ok) throw Error('LIST_FAILED')
    const connection = snapshot.data.connections[0]!
    expect(connection.chatId).toBe('oc_desktop')
    expect(connection.completedThrough).not.toBeNull()
    expect(connection.windowActive).toBe(false)
    expect(connection.status).toBe('active')
    expect(JSON.stringify(snapshot)).not.toContain(token)
    expect(await page.content()).not.toContain(token)
    await expect
      .poll(
        async () => {
          const tasks = await page.evaluate(
            (id) => window.memo.workspace.list({ projectId: id }),
            projectId,
          )
          return tasks.ok ? tasks.data.totalCount : -1
        },
        { timeout: 20000 },
      )
      .toBe(1)
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/feishu-connected-wide.png' })
    expect(
      await readFile(join(profile, 'credentials', 'credentials.json'), 'utf8'),
    ).not.toContain(token)
    // Removal goes through the real main handler: pause and bump grant before deleting the key.
    expect(
      (
        await page.evaluate(
          (id) => window.memo.credentials.remove(id),
          credentialId,
        )
      ).ok,
    ).toBe(true)
    const after = await page.evaluate(() => window.memo.feishu.list())
    if (!after.ok) throw Error('LIST_FAILED')
    expect(after.data.connections[0]!.status).toBe('paused')
    expect(after.data.connections[0]!.grantVersion).toBeGreaterThan(
      connection.grantVersion,
    )
    const stats = await app.evaluate(async (_, fixture) => {
      const { createRequire } = process.getBuiltinModule('module')
      return createRequire(fixture)(fixture).stats() as { paths: string[] }
    }, fixture)
    expect(
      stats.paths.filter((p) => p.includes('/messages?')).length,
    ).toBeGreaterThanOrEqual(3)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

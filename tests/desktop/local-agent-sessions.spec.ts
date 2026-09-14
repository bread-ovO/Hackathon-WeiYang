import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('authorizing local Codex includes archived sessions, more than 200 files and all batches', async () => {
  test.setTimeout(90000)
  const root = await mkdtemp(join(tmpdir(), 'bugu-local-agents-'))
  const codex = join(root, 'codex')
  await mkdir(join(codex, 'sessions'), { recursive: true })
  await mkdir(join(codex, 'archived_sessions'))
  const line = (n: number) =>
    JSON.stringify({
      timestamp: new Date(1760000000000 + n * 1000).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `记录 ${n}` }],
      },
    }) + '\n'
  for (let i = 0; i < 205; i++)
    await writeFile(join(codex, 'sessions', `${i}.jsonl`), line(i))
  await writeFile(
    join(codex, 'archived_sessions', 'archived.jsonl'),
    Array.from({ length: 150 }, (_, i) => line(i + 205)).join(''),
  )
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  env.CODEX_HOME = codex
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  let app = await electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop'), '--mode=real'],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    const project = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('Agent 授权测试')
      if (!r.ok) throw Error('project failed')
      return r.data.projects[0]!.id
    })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('button', { name: '配置 Codex', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Codex 会话导入' })
    await expect(panel.getByLabel('授权项目')).toHaveValue(project)
    await panel
      .getByRole('button', { name: '授权读取本机全部会话', exact: true })
      .click()
    await expect(panel.getByRole('status')).toContainText('已授权 206 个会话')
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const r = await window.memo.sources.list()
            return r.ok
              ? r.data.sources.reduce((sum, s) => sum + s.eventCount, 0)
              : 0
          }),
        { timeout: 30000 },
      )
      .toBe(355)
    await panel
      .getByRole('button', { name: '授权读取本机全部会话', exact: true })
      .click()
    await expect(panel.getByRole('status')).toContainText('已授权 206 个会话')
    const r = await page.evaluate(() => window.memo.sources.list())
    expect(r.ok && r.data.sources.length).toBe(206)
    expect(
      r.ok && r.data.sources.reduce((sum, s) => sum + s.eventCount, 0),
    ).toBe(355)
    await appendFile(
      join(codex, 'archived_sessions', 'archived.jsonl'),
      line(499),
    )
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const state = await window.memo.sources.list()
            return state.ok
              ? state.data.sources.reduce((sum, s) => sum + s.eventCount, 0)
              : 0
          }),
        { timeout: 45000 },
      )
      .toBe(356)
    await app.close()
    await appendFile(
      join(codex, 'archived_sessions', 'archived.jsonl'),
      line(500),
    )
    app = await electron.launch({
      executablePath: require('electron'),
      args: [resolve('apps/desktop'), '--mode=real'],
      env,
    })
    const reopened = await app.firstWindow()
    await expect(
      reopened.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(
        async () =>
          reopened.evaluate(async () => {
            const state = await window.memo.sources.list()
            return state.ok
              ? state.data.sources.reduce((sum, s) => sum + s.eventCount, 0)
              : 0
          }),
        { timeout: 30000 },
      )
      .toBe(356)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

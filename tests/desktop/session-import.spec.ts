import { test, expect, _electron as electron } from '@playwright/test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
const line = (value: unknown) => JSON.stringify(value) + '\n'
// All session content below is fictional dialogue written for this test only.
const claudeSession = [
  line({
    type: 'user',
    uuid: 'c-uuid-1',
    timestamp: '2026-09-12T08:30:00.000Z',
    sessionId: 'claude-session-1',
    message: { role: 'user', content: '周五前把接口文档发给小王' },
  }),
  line({
    type: 'assistant',
    uuid: 'c-uuid-2',
    timestamp: '2026-09-12T08:30:05.000Z',
    sessionId: 'claude-session-1',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '用户在安排文档交付' },
        { type: 'text', text: '好的，我周四整理好初稿。' },
        { type: 'tool_use', name: 'Bash', input: {} },
      ],
    },
  }),
  line({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} }),
  line({
    type: 'system',
    uuid: 'c-uuid-3',
    timestamp: '2026-09-12T08:30:06.000Z',
    content: 'hook',
  }),
].join('')
const codexSession = [
  line({
    timestamp: '2026-09-12T09:00:00.000Z',
    type: 'session_meta',
    payload: { id: 'codex-session-1' },
  }),
  line({
    timestamp: '2026-09-12T09:00:01.000Z',
    ordinal: 0,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '下周评审前完成联调' }],
    },
  }),
  line({
    timestamp: '2026-09-12T09:00:02.000Z',
    ordinal: 1,
    type: 'response_item',
    payload: { type: 'reasoning', summary: [] },
  }),
  line({
    timestamp: '2026-09-12T09:00:03.000Z',
    ordinal: 2,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '收到，我会先搭测试环境。' }],
    },
  }),
  line({
    timestamp: '2026-09-12T09:00:04.000Z',
    ordinal: 3,
    type: 'response_item',
    payload: { type: 'token_count', total: 128 },
  }),
].join('')
async function patchDialog(
  app: Awaited<ReturnType<typeof electron.launch>>,
  directory: string | null,
) {
  await app.evaluate(({ dialog }, value) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () =>
        value === null
          ? { canceled: true, filePaths: [] }
          : { canceled: false, filePaths: [value] },
    })
  }, directory)
}
test('built-in Claude Code and Codex session directories import without exposing filesystem paths', async () => {
  const data = await mkdtemp(join(tmpdir(), 'bugu-session-'))
  const claudeDir = join(data, 'claude')
  const codexDir = join(data, 'codex')
  const emptyDir = join(data, 'empty')
  await mkdir(join(claudeDir, 'subagents'), { recursive: true })
  await mkdir(codexDir, { recursive: true })
  await mkdir(emptyDir, { recursive: true })
  await writeFile(join(claudeDir, 'session-one.jsonl'), claudeSession)
  await writeFile(join(claudeDir, 'subagents', 'session-two.jsonl'), claudeSession)
  await writeFile(join(codexDir, 'rollout-2026-09-12-session.jsonl'), codexSession)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(data, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    const project = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('会话导入测试')
      if (!r.ok) throw new Error('PROJECT_FAILED')
      return r.data.projects[0]!.id
    })
    await page.getByRole('button', { name: '连接', exact: true }).click()
    // Both preset cards exist with the built-in badge.
    await expect(
      page.getByRole('heading', { name: 'Claude Code 会话', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Codex 会话', exact: true }),
    ).toBeVisible()

    await patchDialog(app, claudeDir)
    await page
      .getByRole('button', { name: '配置 Claude Code', exact: true })
      .click()
    const claudePanel = page.getByRole('region', {
      name: 'Claude Code 会话导入',
    })
    await claudePanel.getByLabel('授权项目').selectOption(project)
    await claudePanel
      .getByRole('button', { name: '授权会话目录', exact: true })
      .click()
    await expect(claudePanel.getByRole('status')).toContainText(
      '发现 2 个会话文件，已收录 2 个',
    )
    await expect(claudePanel).toContainText('已接收 2 条')

    // Codex directory import; the Claude panel keeps listing only its own kind.
    await patchDialog(app, codexDir)
    await page.getByRole('button', { name: '配置 Codex', exact: true }).click()
    const codexPanel = page.getByRole('region', { name: 'Codex 会话导入' })
    await codexPanel.getByLabel('授权项目').selectOption(project)
    await codexPanel
      .getByRole('button', { name: '授权会话目录', exact: true })
      .click()
    await expect(codexPanel.getByRole('status')).toContainText(
      '发现 1 个会话文件，已收录 1 个',
    )
    await expect(codexPanel).toContainText('已接收 2 条')
    await expect(claudePanel).toContainText('已接收 2 条')

    // Empty directories are a normal outcome, not an error.
    await patchDialog(app, emptyDir)
    await codexPanel
      .getByRole('button', { name: '授权会话目录', exact: true })
      .click()
    await expect(codexPanel.getByRole('status')).toContainText(
      '该目录下没有找到会话文件',
    )

    // Cancel keeps existing connections untouched.
    await patchDialog(app, null)
    await claudePanel
      .getByRole('button', { name: '授权会话目录', exact: true })
      .click()
    await expect(claudePanel.getByRole('status')).toContainText('已取消')

    const listed = await page.evaluate(() => window.memo.sources.list())
    if (!listed.ok) throw new Error('SOURCE_FAILED')
    expect(listed.data.sources).toHaveLength(3)
    for (const source of listed.data.sources) {
      expect(JSON.stringify(source)).not.toContain(data)
      expect(Object.keys(source)).not.toContain('path')
      expect(Object.keys(source)).not.toContain('cursor')
    }
    // Imported events stay queryable through the normal workspace chain.
    const seen: string[] = []
    for (const source of listed.data.sources) {
      const events = await page.evaluate(async (input) => {
        const r = await window.memo.workspace.sourceEvents(input)
        if (!r.ok) throw new Error('EVENTS_FAILED')
        return r.data.events.map((event) => event.excerpt)
      }, {
        projectId: project,
        sourceInstanceId: source.id,
      })
      expect(events.length).toBe(2)
      seen.push(...events)
    }
    expect(seen.some((text) => text.includes('周五前把接口文档发给小王'))).toBe(
      true,
    )
    expect(seen.some((text) => text.includes('下周评审前完成联调'))).toBe(true)
    // No path leaks into the rendered page text either.
    const bodyText = await page.evaluate(() => document.body.innerText)
    expect(bodyText).not.toContain(data)

    // Sync and revoke keep working for session sources.
    await claudePanel
      .getByRole('button', { name: '继续同步', exact: true })
      .first()
      .click()
    await expect(claudePanel.getByRole('status')).toContainText(
      '本批记录已接收',
    )
    await claudePanel
      .getByRole('button', { name: '撤销授权', exact: true })
      .first()
      .click()
    await expect(claudePanel.getByRole('status')).toContainText('授权已撤销')
    await page.screenshot({ path: 'test-results/session-import-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    await page.screenshot({ path: 'test-results/session-import-narrow.png' })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})

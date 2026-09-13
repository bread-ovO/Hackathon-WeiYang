import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
test('known version confirmation is reference-scoped, expires on new content and cannot undo retraction', async () => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'bugu-reference-review-')),
    file = join(root, 'fictional.jsonl')
  const line = (
    revision: string,
    content: string,
    operation: 'upsert' | 'retract' = 'upsert',
  ) =>
    JSON.stringify({
      id: 'message',
      revision,
      content,
      operation,
      role: 'user',
      created_at: '2026-09-13T00:00:00Z',
    }) + '\n'
  await writeFile(file, line('1', '我会提交原始虚构报告。'))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
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
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    const projectId = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('版本复核')
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
    const task = await page.evaluate(async (id) => {
      const r = await window.memo.workspace.list({ projectId: id })
      if (!r.ok) throw Error('LIST_FAILED')
      return r.data.tasks[0]!
    }, projectId)
    const references = await page.evaluate(
      ({ projectId, taskId }) =>
        window.memo.workspace.listReferences({ projectId, taskId }),
      { projectId, taskId: task.id },
    )
    if (!references.ok) throw Error('REFERENCES_FAILED')
    const reference = references.data.references[0]!
    const scope = {
      projectId,
      taskId: task.id,
      referenceKind: reference.kind,
      referenceId: reference.id,
    }
    const sources = await page.evaluate(() => window.memo.sources.list())
    if (!sources.ok) throw Error('SOURCE_FAILED')
    const sourceId = sources.data.sources[0]!.id
    expect(
      (await page.evaluate(() => window.memo.processing.configure(false))).ok,
    ).toBe(true)
    const sync = async (
      revision: string,
      text: string,
      operation: 'upsert' | 'retract' = 'upsert',
    ) => {
      await appendFile(file, line(revision, text, operation))
      expect(
        (await page.evaluate((id) => window.memo.sources.sync(id), sourceId))
          .ok,
      ).toBe(true)
    }
    await sync('2', '我会提交第二版虚构报告。')
    const review = await page.evaluate(
      (scope) => window.memo.workspace.reviewReference(scope),
      scope,
    )
    if (!review.ok) throw Error('REVIEW_FAILED')
    expect(review.data.reference.status).toBe('review_required')
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page
      .getByRole('button')
      .filter({ has: page.locator('.task-title', { hasText: task.title }) })
      .click()
    const draft = page.getByLabel('编辑事项标题')
    await draft.fill('未保存的版本复核草稿')
    await page.getByText('关联、改期与历史', { exact: true }).click()
    const panel = page.getByRole('region', {
      name: `引用版本复核 ${reference.kind} ${reference.id}`,
      exact: true,
    })
    await panel
      .getByRole('button', { name: '复核引用版本', exact: true })
      .click()
    const selected = review.data.events.find((e) => e.revision === '2')!
    await panel.getByLabel('选择已知版本').selectOption(String(selected.id))
    await panel.getByLabel('确认依据').fill('人工核对第二版符合当前约定')
    await panel.getByRole('button', { name: '确认使用所选版本' }).click()
    await expect(panel).toContainText('已确认使用此版本')
    await expect(draft).toHaveValue('未保存的版本复核草稿')
    await expect(
      panel.locator('.reference-confirmation blockquote'),
    ).toHaveText(selected.text)
    await panel.locator('.reference-confirmation').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/reference-confirmed-wide.png' })
    const confirmed = await page.evaluate(
      (scope) => window.memo.workspace.reviewReference(scope),
      scope,
    )
    if (!confirmed.ok) throw Error('REVIEW_FAILED')
    expect(confirmed.data.reference.status).toBe('confirmed')
    await sync('3', selected.text)
    const replay = await page.evaluate(
      (scope) => window.memo.workspace.reviewReference(scope),
      scope,
    )
    expect(replay.ok && replay.data.reference.status).toBe('confirmed')
    await sync('4', '我会提交第四版不同内容。')
    const stale = await page.evaluate(
      (input) => window.memo.workspace.confirmReference(input),
      {
        ...scope,
        chosenEventId: selected.id,
        knownContentSetDigest: confirmed.data.knownContentSetDigest,
        expectedReferenceVersion: confirmed.data.reference.version,
        reason: '过时的确认请求',
      },
    )
    expect(stale.ok).toBe(false)
    await panel.getByRole('button', { name: '刷新版本列表' }).click()
    await expect(panel).toContainText('引用版本待复核：已知内容发生变化')
    await sync('5', '', 'retract')
    await panel.getByRole('button', { name: '刷新版本列表' }).click()
    await expect(panel).toContainText('不能通过版本确认恢复')
    await expect(
      panel.getByRole('button', { name: '确认使用所选版本' }),
    ).toBeDisabled()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    await page.screenshot({
      path: 'test-results/reference-retracted-narrow.png',
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    const saved = await page.evaluate(
      ({ projectId, taskId }) =>
        window.memo.workspace.detail(projectId, taskId),
      scope,
    )
    expect(saved.ok && saved.data.task).toEqual(task)
    await expect(draft).toHaveValue('未保存的版本复核草稿')
    // Read through the actual core timeline after live import/edit/confirmation/retraction.
    const timelineScope = { projectId, taskId: task.id }
    const history = await page.evaluate(
      (input) => window.memo.workspace.timeline(input),
      timelineScope,
    )
    if (!history.ok) throw Error('TIMELINE_FAILED')
    expect(history.data.nextCursor).toBeNull()
    const entries = history.data.entries
    expect(entries.filter((e) => e.kind === 'reference_conflict')).toHaveLength(
      2,
    )
    expect(
      entries.filter((e) => e.kind === 'reference_confirmation'),
    ).toHaveLength(1)
    expect(entries.some((e) => e.kind === 'rule')).toBe(true)
    expect(
      entries.some(
        (e) =>
          e.kind === 'retraction' &&
          e.evidence?.revision === '5' &&
          e.evidence.operation === 'retract',
      ),
    ).toBe(true)
    expect(
      entries
        .filter((e) => e.kind === 'reference_conflict')
        .map((e) => e.evidence?.revision)
        .sort(),
    ).toEqual(['2', '4'])
    const timeline = page.getByRole('region', {
      name: '事项时间线',
      exact: true,
    })
    await timeline
      .getByRole('button', { name: '查看事项时间线', exact: true })
      .click()
    await expect(timeline.locator('.task-timeline-entry')).toHaveCount(
      entries.length,
    )
    await expect(draft).toHaveValue('未保存的版本复核草稿')
    await timeline
      .getByRole('button', { name: '刷新时间线', exact: true })
      .click()
    await expect(timeline.locator('.task-timeline-entry')).toHaveCount(
      entries.length,
    )
    await expect(draft).toHaveValue('未保存的版本复核草稿')
    await timeline.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: 'test-results/timeline-live-audit-narrow.png',
    })
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

// Fixture-only seed: existing manual evidence is reviewed through the real bridge/UI.
// This does not assert a manual-evidence creation UI exists.
test('existing manual evidence supports independent version confirmation through the UI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-manual-reference-')),
    file = join(root, 'fictional.jsonl')
  const row = (revision: string, content: string) =>
    JSON.stringify({
      id: 'manual-message',
      revision,
      role: 'user',
      created_at: '2026-09-13T00:00:00Z',
      content,
    }) + '\n'
  await writeFile(file, row('1', '人工证据原文第一版。'))
  const output = join(root, 'seed.cjs')
  await build({
    entryPoints: [resolve('tests/fixtures/manual-reference-seed.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['better-sqlite3'],
    tsconfig: resolve('tsconfig.json'),
  })
  execFileSync(requireDesktop('electron'), [output, root], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: resolve('apps/desktop/node_modules'),
    },
    timeout: 30000,
  })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
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
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    await appendFile(file, row('2', '人工核对的新整条消息。'))
    const sources = await page.evaluate(() => window.memo.sources.list())
    if (!sources.ok) throw Error('SOURCE_FAILED')
    const manualSync = await page.evaluate(
      (id) => window.memo.sources.sync(id),
      sources.data.sources[0]!.id,
    )
    if (!manualSync.ok) {
      const diagnostic = await page.evaluate(() => window.memo.sources.list())
      throw Error(JSON.stringify({ reply: manualSync, diagnostic }))
    }
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page
      .getByRole('button')
      .filter({
        has: page.locator('.task-title', { hasText: '已有人工证据事项' }),
      })
      .click()
    await page.getByText('关联、改期与历史', { exact: true }).click()
    const panel = page.getByRole('region', {
      name: '引用版本复核 manual manual-evidence',
      exact: true,
    })
    await panel
      .getByRole('button', { name: '复核引用版本', exact: true })
      .click()
    await panel
      .getByLabel('选择已知版本')
      .selectOption({ label: '修订 2 · 用户 · 事件 #2' })
    await panel.getByLabel('确认依据').fill('已人工核对新版本适用于此条件')
    await panel.getByRole('button', { name: '确认使用所选版本' }).click()
    await expect(panel.locator('.reference-confirmation')).toContainText(
      '已确认使用此版本',
    )
    await expect(
      panel.locator('.reference-confirmation blockquote'),
    ).toHaveText('人工核对的新整条消息。')
    await expect(
      page.getByRole('region', { name: '引用版本复核', exact: true }),
    ).toContainText('原始引用保持失效')
    await panel.locator('.reference-confirmation').scrollIntoViewIfNeeded()
    await page.screenshot({
      path: 'test-results/reference-manual-confirmed.png',
    })
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

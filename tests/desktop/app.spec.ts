import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('packaged renderer connects to isolated SQLite core without exposing Node', async () => {
  const data = await mkdtemp(join(tmpdir(), 'memo-desktop-'))
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = data
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
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-runtime > summary').click()
    await expect(page.getByText('本地核心已就绪')).toBeVisible({
      timeout: 15000,
    })
    expect(
      await page.evaluate(() => ({
        node: typeof (globalThis as unknown as { require: unknown }).require,
        keys: Object.keys(window.memo),
      })),
    ).toEqual({
      node: 'undefined',
      keys: [
        'platform',
        'startupMode',
        'onOpenPetSettings',
        'onOpenTask',
        'feishu',
        'github',
        'pet',
        'ingestion',
        'chat',
        'modelProvider',
        'analysis',
        'processing',
        'health',
        'plugins',
        'credentials',
        'exports',
        'sources',
        'workspace',
      ],
    })

    await expect(
      page.getByRole('heading', { name: '基础链路已连通' }),
    ).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-settings.png',
    })
    await expect(
      page.getByRole('button', { name: '设置', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    const reply = await page.evaluate(() => window.memo.health())
    expect(reply.ok).toBe(true)
    if (reply.ok) {
      expect(reply.data.eventCount).toBe(0)
      expect(reply.data.schemaVersion).toBe(25)
    }
    const modelStatus = await page.evaluate(() =>
      window.memo.modelProvider.status(),
    )
    expect(modelStatus.ok && modelStatus.data.config.enabled).toBe(false)
    const savedModel = await page.evaluate(() =>
      window.memo.modelProvider.configure({
        provider: 'chat-completions',
        enabled: false,
        baseUrl: 'https://example.com/v1',
        model: 'fixture-model',
        credentialId: '',
      }),
    )
    expect(savedModel.ok && savedModel.data.config.provider).toBe(
      'chat-completions',
    )
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-model > summary').click()
    await expect(page.getByLabel('模型接入方式')).toHaveValue(
      'chat-completions',
    )
    await expect(page.getByLabel('分析模型名称')).toHaveValue('fixture-model')
    await page.getByLabel('模型接入方式').selectOption('responses')
    await page
      .getByRole('button', { name: '保存模型配置', exact: true })
      .click()
    await expect(
      page.getByText('配置已保存。下次分析使用此服务。'),
    ).toBeVisible()
    expect(
      (await page.evaluate(() => window.memo.modelProvider.status())).ok,
    ).toBe(true)
    // Terminate only our named child process and verify a different, healthy core replaces it.
    const oldPid = await app.evaluate(({ app }) => {
      const metric = app
        .getAppMetrics()
        .find((item) => item.name === 'Memo Core')
      if (!metric) throw new Error('CORE_METRIC_MISSING')
      process.kill(metric.pid, 'SIGTERM')
      return metric.pid
    })
    await expect
      .poll(() =>
        app.evaluate(
          ({ app }, pid) =>
            app
              .getAppMetrics()
              .some((item) => item.name === 'Memo Core' && item.pid !== pid),
          oldPid,
        ),
      )
      .toBe(true)
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
    // External windows are denied even when requested by the trusted renderer.
    await page.evaluate(() => window.open('https://example.com'))
    expect(app.windows()).toHaveLength(1)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await expect(page.getByRole('button', { name: '即将支持' })).toHaveCount(0)
    await page.getByRole('button', { name: '配置飞书', exact: true }).click()
    await page.getByRole('button', { name: '配置 GitHub', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '飞书会话连接' }),
    ).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: '飞书会话连接' })
        .getByRole('button', { name: '验证并启用会话' }),
    ).toBeVisible()
    await expect(
      page.getByRole('region', { name: 'GitHub仓库连接' }),
    ).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: 'GitHub仓库连接' })
        .getByRole('button', { name: '验证并启用仓库' }),
    ).toBeVisible()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-connections.png',
    })
    await page.getByRole('button', { name: /^跟进/ }).click()
    await page.screenshot({
      animations: 'disabled',
      path: 'test-results/desktop-home.png',
    })
    // Real mode now starts empty; the old hard-coded demo tasks are gone.
    // Manual task editing/filtering has dedicated workspace/task-interface specs.
    await expect(page.locator('.task-row')).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: '新建第一件事' }),
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: '示例体验', exact: true }),
    ).toHaveCount(0)
    const after = await page.evaluate(() => window.memo.health())
    expect(after.ok && after.data.eventCount === 0).toBe(true)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 700),
    )
    for (const [name, file] of [
      ['连接', 'connections'],
      ['设置', 'settings'],
    ] as const) {
      await page.getByRole('button', { name, exact: true }).click()
      await page.screenshot({
        animations: 'disabled',
        path: `test-results/desktop-${file}-narrow.png`,
      })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
    }
    await page.evaluate(() =>
      window.memo.workspace.createProject('聊天隔离测试'),
    )
    await page.getByRole('button', { name: 'AI 聊天', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '和不咕聊聊' }),
    ).toBeVisible()
    await page.getByRole('button', { name: /看看待办/ }).click()
    await expect(
      page.getByRole('textbox', { name: '发送给不咕' }),
    ).toBeFocused()
    await expect(page.getByRole('textbox', { name: '发送给不咕' })).toHaveValue(
      '有哪些任务还没完成？',
    )
    await page.getByRole('button', { name: '模型设置', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(
      page.getByRole('combobox', { name: '模型接入方式' }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
    await expect(
      page.getByRole('button', { name: '模型设置', exact: true }),
    ).toBeFocused()
    await page
      .getByRole('textbox', { name: '发送给不咕' })
      .fill('新增一个虚构任务')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await expect(page.getByText('请先配置并启用分析模型。')).toBeVisible({
      timeout: 10000,
    })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
  } finally {
    await app.close()
    await rm(data, { recursive: true, force: true })
  }
})

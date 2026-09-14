import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('compact pages disclose configuration on demand and align icons at both widths', async ({}, info) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-layout-')))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  env.MEMO_TEST_USER_DATA = root
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
    for (const width of [1140, 880]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setSize(width, 780),
        width,
      )
      await page.getByRole('button', { name: '连接', exact: true }).click()
      await expect(page.getByRole('region', { name: 'AI 事项分析' })).toHaveCount(0)
      await expect(page.getByLabel('飞书会话ID')).not.toBeVisible()
      await expect(
        page.getByRole('button', { name: '一键体验', exact: true }),
      ).toBeVisible()
      await page.screenshot({
        path: info.outputPath(`connections-${width}.png`),
      })
      const help = page.getByRole('button', { name: '扩展插件说明', exact: true })
      await help.hover()
      await expect(page.getByRole('tooltip')).toContainText('安装和管理')
      await help.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('#preset-plugins')).not.toHaveAttribute('open', '')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('tooltip')).not.toBeVisible()
      await page.getByRole('button', { name: '配置飞书', exact: true }).click()
      await expect(page.getByLabel('飞书会话ID')).toBeVisible()
      await page.getByLabel('飞书会话ID').fill('oc_draft')
      await page.locator('#preset-feishu > summary').click()
      await page.getByRole('button', { name: '配置飞书', exact: true }).click()
      await expect(page.getByLabel('飞书会话ID')).toHaveValue('oc_draft')
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByLabel('凭据名称')).not.toBeVisible()
      await page.screenshot({ path: info.outputPath(`settings-${width}.png`) })
      await expect(page.locator('.settings-page .disclosure-description')).toHaveCount(0)
      await expect(page.locator('.setting-card-heading > div > p')).toHaveCount(0)
      const summary = page.locator('#settings-credentials > summary')
      await summary.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByLabel('凭据名称')).toBeVisible()
      await summary.focus()
      await page.keyboard.press('Space')
      await expect(page.getByLabel('凭据名称')).not.toBeVisible()
      await page.getByRole('button', { name: 'AI 聊天', exact: true }).click()
      await expect(page.getByRole('button', { name: '聊天操作说明', exact: true })).toBeVisible()
      await expect(page.locator('.task-chat-footnote')).toHaveCount(0)
      await expect(page.getByRole('textbox', { name: '发送给不咕' })).toBeVisible()
      await page.screenshot({ path: info.outputPath(`chat-${width}.png`) })
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        icons: Array.from(document.querySelectorAll('.nav-item svg')).map((svg) => {
          const i = svg.getBoundingClientRect(),
            b = svg.closest('button')!.getBoundingClientRect()
          return Math.abs(i.y + i.height / 2 - (b.y + b.height / 2))
        }),
      }))
      expect(geometry.overflow).toBe(false)
      expect(geometry.icons.length).toBeGreaterThan(0)
      expect(geometry.icons.every((delta) => delta < 1)).toBe(true)
    }
    await page.evaluate(async () => {
      const project = await window.memo.workspace.createProject('界面走查')
      if (!project.ok) throw Error('PROJECT_FAILED')
      await window.memo.workspace.createTask(
        project.data.projects[0]!.id,
        '核对接口说明并反馈给同事',
      )
    })
    await page.getByRole('button', { name: '跟进 5', exact: true }).click()
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await expect(page.getByRole('button', { name: 'AI 整理', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('选择分析会话')).toHaveCount(0)
    await page.getByRole('button', { name: '自动整理', exact: true }).click()
    await expect(page.getByLabel('模型接入方式')).toBeVisible()
    await page.getByRole('button', { name: /^跟进/ }).first().click()
    await page.getByRole('button', { name: /核对接口说明并反馈给同事/ }).click()
    await expect(
      page.getByRole('region', { name: '事项时间线', exact: true }),
    ).not.toBeVisible()
    for (const width of [1140, 880]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0]!.setSize(width, 780),
        width,
      )
      await page.screenshot({ path: info.outputPath(`task-${width}.png`) })
      expect(
        await page
          .locator('.real-editor')
          .evaluate((element) => getComputedStyle(element).overflowY),
      ).toBe('auto')
    }
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

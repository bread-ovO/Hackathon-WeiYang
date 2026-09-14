import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
async function launch(profileRoot: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => v[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  env.MEMO_TEST_USER_DATA = join(profileRoot, 'profile')
  return electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
}
async function close(app: ElectronApplication | undefined) {
  if (!app) return
  await app.evaluate(({ app }) => app.quit()).catch(() => {})
  await app.close().catch(() => {})
}
async function openSettings(page: Page) {
  await expect(
    page.getByRole('heading', { name: '跟进', exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.locator('#settings-pet > summary').click()
  const settings = page.getByRole('region', { name: '自动话语设置' })
  await expect(
    settings.getByRole('switch', { name: '自动话语', exact: true }),
  ).toBeEnabled()
  return settings
}

test('automatic speech settings remain opt-in and persist across restart without SDK assets', async ({}, testInfo) => {
  test.setTimeout(90000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-speech-ui-')),
  )
  let app: ElectronApplication | undefined
  try {
    app = await launch(root)
    let page = await app.firstWindow()
    let settings = await openSettings(page)
    const initial = await page.evaluate(() => window.memo.pet.state())
    expect(initial.ok && initial.data.speech?.preferences).toEqual({
      enabled: false,
      frequency: 'normal',
      quietStart: 1320,
      quietEnd: 540,
      pausedUntil: null,
    })
    expect(initial.ok && initial.data.speech?.status).toBe('disabled')
    await settings.getByRole('button', { name: '自动话语说明' }).hover()
    await expect(page.getByRole('tooltip')).toContainText('只有开启后才会自动显示')
    await page.keyboard.press('Escape')
    await settings
      .getByRole('switch', { name: '自动话语', exact: true })
      .click()
    await expect(
      settings.getByRole('switch', { name: '自动话语', exact: true }),
    ).toBeEnabled()
    await settings.getByLabel('出现频率', { exact: true }).selectOption('low')
    await expect(settings.getByLabel('出现频率', { exact: true })).toHaveValue(
      'low',
    )
    await expect(settings.getByLabel('静默开始时间')).toBeEnabled()
    await settings.getByLabel('静默开始时间').fill('23:00')
    await settings.getByLabel('静默结束时间').fill('08:00')
    await settings
      .getByRole('button', { name: '保存时段', exact: true })
      .click()
    await expect
      .poll(async () => {
        const state = await page.evaluate(() => window.memo.pet.state())
        return state.ok ? state.data.speech?.preferences : null
      })
      .toMatchObject({
        enabled: true,
        frequency: 'low',
        quietStart: 1380,
        quietEnd: 480,
        pausedUntil: null,
      })
    await settings
      .getByRole('button', { name: '暂停 1 小时', exact: true })
      .click()
    await expect(
      settings.getByRole('button', { name: '恢复自动话语', exact: true }),
    ).toBeEnabled()
    const paused = await page.evaluate(() => window.memo.pet.state())
    if (!paused.ok || !paused.data.speech?.preferences.pausedUntil)
      throw Error('PAUSE_MISSING')
    expect(
      paused.data.speech.preferences.pausedUntil - Date.now(),
    ).toBeGreaterThan(3500000)
    expect(
      paused.data.speech.preferences.pausedUntil - Date.now(),
    ).toBeLessThanOrEqual(3600000)
    await settings
      .getByRole('button', { name: '恢复自动话语', exact: true })
      .click()
    await expect(
      settings.getByRole('button', { name: '暂停 1 小时', exact: true }),
    ).toBeEnabled()
    const beforeInvalid = await page.evaluate(() => window.memo.pet.state())
    const invalid = await page.evaluate(() =>
      window.memo.pet.configureSpeech({
        pausedUntil: Date.now() + 7 * 24 * 3600000,
      }),
    )
    expect(invalid.ok).toBe(false)
    const afterInvalid = await page.evaluate(() => window.memo.pet.state())
    expect(afterInvalid.ok && afterInvalid.data.speech?.preferences).toEqual(
      beforeInvalid.ok && beforeInvalid.data.speech?.preferences,
    )
    await settings
      .getByRole('switch', { name: '自动话语', exact: true })
      .click()
    await expect(
      settings.getByRole('switch', { name: '自动话语', exact: true }),
    ).toBeEnabled()
    await close(app)
    app = await launch(root)
    page = await app.firstWindow()
    settings = await openSettings(page)
    const restored = await page.evaluate(() => window.memo.pet.state())
    expect(restored.ok && restored.data.speech?.preferences).toEqual({
      enabled: false,
      frequency: 'low',
      quietStart: 1380,
      quietEnd: 480,
      pausedUntil: null,
    })
    await expect(settings.getByLabel('出现频率', { exact: true })).toHaveValue(
      'low',
    )
    await expect(settings.getByLabel('静默开始时间')).toHaveValue('23:00')
    await expect(settings.getByLabel('静默结束时间')).toHaveValue('08:00')
    // Exercise responsive settings at actual BrowserWindow widths, not only a synthetic viewport.
    for (const width of [1440, 880]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const main = BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().startsWith('memo-pet:'),
        )!
        main.setSize(width, 1000)
      }, width)
      await settings.scrollIntoViewIfNeeded()
      const geometry = await settings.evaluate((el) => ({
        content: el.scrollWidth,
        visible: el.clientWidth,
      }))
      expect(geometry.content).toBeLessThanOrEqual(geometry.visible + 1)
      await expect(
        settings.getByRole('switch', { name: '自动话语', exact: true }),
      ).toBeVisible()
      await page.screenshot({
        path: testInfo.outputPath(`pet-speech-settings-${width}.png`),
      })
    }
    expect((await page.evaluate(() => window.memo.pet.state())).ok).toBe(true)
  } finally {
    await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(resolve('apps/desktop/package.json'))

const png = () => {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(type, 4)
    data.copy(result, 8)
    result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2)
  header.writeUInt32BE(2, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(18))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const stubDialog = (app: ElectronApplication, result: object) =>
  app.evaluate(
    eval(
      `payload => { payload.dialog.showOpenDialog = async () => (${JSON.stringify(result)}) }`,
    ) as (electron: { dialog: { showOpenDialog: unknown } }) => void,
  )
const launch = async (data: string) => {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = data
  delete env.ELECTRON_RUN_AS_NODE
  return electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
}
const windowSummaries = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      focusable: w.isFocusable(),
    })),
  )

test.describe('PET09/10/11 proactive speech', () => {
  let data: string
  test.beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'memo-pet-speech-'))
  })
  test.afterEach(async () => {
    await rm(data, { recursive: true, force: true })
  })

  test('speech settings persist and the bubble follows pet visibility rules', async ({}, testInfo) => {
    testInfo.setTimeout(150_000)
    const fixture = join(data, 'fixture')
    await mkdir(fixture, { recursive: true })
    await writeFile(
      join(fixture, 'pet.model3.json'),
      JSON.stringify({ Version: 3, FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] } }),
    )
    await writeFile(join(fixture, 'pet.moc3'), Buffer.from('MOC3\x01\0\0\0'))
    await writeFile(join(fixture, 'pet.png'), png())
    const app = await launch(data)
    try {
      const page = await app.firstWindow()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('heading', { name: '桌宠说话' })).toBeVisible()
      await expect(page.getByText('已开启 · 今天 0/6 句')).toBeVisible()

      // PET11: toggling persists to disk and survives reload.
      await page.getByRole('button', { name: '关闭说话' }).click()
      await expect(page.getByText('已关闭 · 今天 0/6 句')).toBeVisible()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByText('已关闭 · 今天 0/6 句')).toBeVisible()
      const saved = JSON.parse(await readFile(join(data, 'pet-speech.json'), 'utf8'))
      expect(saved.config.enabled).toBe(false)
      await page.getByRole('button', { name: '开启说话' }).click()
      await expect(page.getByText('已开启 · 今天 0/6 句')).toBeVisible()

      // Preview without the pet on screen politely refuses.
      await page.getByRole('button', { name: '试一句话' }).click()
      await expect(page.getByText('请先显示桌宠后再试。')).toBeVisible()

      // Import + select + show the pet, then the bubble appears unfocused.
      await stubDialog(app, { canceled: false, filePaths: [fixture] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await expect(page.getByText('模型已导入，可在列表中设为当前。')).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: '设为当前' }).click()
      await page.getByRole('button', { name: '显示桌宠' }).click()
      await expect(page.getByText('桌宠已显示在桌面上。')).toBeVisible()
      await page.getByRole('button', { name: '试一句话' }).click()
      await expect(page.getByText('气泡已显示在桌宠旁。')).toBeVisible()

      await expect.poll(() => app.windows().length).toBe(3)
      const bubblePage = app.windows().find(
        (candidate) => candidate !== page && !(candidate as Page).url().includes('pet.html'),
      ) as Page
      await expect(bubblePage.getByText('要不要看看今天还在跟进的事？')).toBeVisible({ timeout: 15_000 })
      // PET09: the bubble never steals keyboard focus.
      const summaries = await windowSummaries(app)
      expect(summaries.filter((w) => w.visible && !w.focusable)).toHaveLength(1)
      await bubblePage.screenshot({
        animations: 'disabled',
        path: 'test-results/pet09-bubble.png',
      })
      await bubblePage.getByRole('button', { name: '知道了' }).click()
      await expect(bubblePage.getByText('要不要看看今天还在跟进的事？')).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})

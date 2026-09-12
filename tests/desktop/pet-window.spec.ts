import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
const writeModel = async (dir: string) => {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'pet.model3.json'),
    JSON.stringify({ Version: 3, FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] } }),
  )
  await writeFile(join(dir, 'pet.moc3'), Buffer.from('MOC3\x01\0\0\0'))
  await writeFile(join(dir, 'pet.png'), png())
}
const stubDialog = (app: ElectronApplication, result: object) =>
  app.evaluate(
    eval(
      `payload => { payload.dialog.showOpenDialog = async () => (${JSON.stringify(result)}) }`,
    ) as (electron: { dialog: { showOpenDialog: unknown } }) => void,
  )
const windowFlags = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      visible: w.isVisible(),
      resizable: w.isResizable(),
      onTop: w.isAlwaysOnTop(),
    })),
  )

test.describe('PET05/07/08 pet window', () => {
  let data: string
  test.beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'memo-pet-window-'))
  })
  test.afterEach(async () => {
    await rm(data, { recursive: true, force: true })
  })

  test('shows a frameless pet, isolates crashes, hides with main window alive', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    const fixture = join(data, 'fixture')
    await writeModel(fixture)
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
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('heading', { name: '桌宠模型' })).toBeVisible()

      // PET05: showing requires a current model first.
      await expect(page.getByRole('button', { name: '显示桌宠' })).toBeDisabled()
      await stubDialog(app, { canceled: false, filePaths: [fixture] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await expect(
        page.getByText('模型已导入，可在列表中设为当前。'),
      ).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: '设为当前' }).click()
      await expect(page.getByText('pet.model3.json · 当前')).toBeVisible()

      await page.getByRole('button', { name: '显示桌宠' }).click()
      await expect(page.getByText('桌宠已显示在桌面上。')).toBeVisible()
      await expect
        .poll(() => app.windows().length)
        .toBe(2)
      const flags = await windowFlags(app)
      expect(flags.filter((f) => f.visible)).toHaveLength(2)
      // Identify the pet by its frameless signature instead of ordering.
      const pet = flags.filter((f) => !f.resizable && f.onTop)
      expect(pet).toHaveLength(1)
      const workspace = flags.filter((f) => f.resizable && !f.onTop)
      expect(workspace).toHaveLength(1)

      // PET05: the pet renderer is sandboxed with only the input bridge.
      const petPage = app.windows().find((candidate) => candidate !== page) as Page
      expect(
        await petPage.evaluate(() => ({
          node: typeof (globalThis as { require?: unknown }).require,
          title: document.title,
          hasInput: typeof (window as { petInput?: unknown }).petInput,
        })),
      ).toEqual({ node: 'undefined', title: 'BUGU 桌宠', hasInput: 'object' })
      await petPage.waitForTimeout(400)
      await petPage.screenshot({
        animations: 'disabled',
        path: 'test-results/pet05-window.png',
      })

      // PET08: the pet window never closes by itself; closing hides it.
      const petClosed = await app.evaluate(({ BrowserWindow }) => {
        const pet = BrowserWindow.getAllWindows().find((w) => !w.isResizable())!
        pet.close()
        return { count: BrowserWindow.getAllWindows().length, petVisible: pet.isVisible() }
      })
      expect(petClosed.count).toBe(2)
      expect(petClosed.petVisible).toBe(false)

      // PET05: a dead pet renderer never takes the workspace down.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => !w.isResizable())!
          .webContents.forcefullyCrashRenderer()
      })
      // PET05: a dead pet renderer never takes the workspace down. The
      // settings surface self-heals: hide (stale intent) then show again.
      await expect
        .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
        .toBe(true)
      await page.getByRole('button', { name: '隐藏桌宠' }).click()
      await page.getByRole('button', { name: '显示桌宠' }).click()
      await expect(page.getByText('桌宠已显示在桌面上。')).toBeVisible()

      // PET08/05: the settings page stays the single control surface.
      await page.getByRole('button', { name: '隐藏桌宠' }).click()
      const hidden = await windowFlags(app)
      expect(hidden.filter((f) => f.visible).length).toBeLessThan(2)
      await page.screenshot({
        animations: 'disabled',
        path: 'test-results/pet05-hidden.png',
      })

      // PET05: closing the workspace keeps the app alive (tray owns exit).
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => w.isResizable())!
          .close()
      })
      await page.waitForTimeout(400)
      expect(await app.evaluate(() => true)).toBe(true)
      const afterClose = await windowFlags(app)
      expect(afterClose.filter((f) => f.visible)).toHaveLength(0)
    } finally {
      await app.close()
    }
  })
})

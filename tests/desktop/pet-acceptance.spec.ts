import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(resolve('apps/desktop/package.json'))
const repoRoot = resolve('.')
const haruDir = join(repoRoot, '.pet-sdk/CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
const haruAvailable = existsSync(join(haruDir, 'Haru.model3.json'))

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
const writeModel = async (dir: string, entry = 'pet.model3.json') => {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, entry),
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
const petWindowOf = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find((w) => !w.isResizable()),
  )

test.describe('PET16 pet integration acceptance', () => {
  let data: string
  test.beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'memo-pet-accept-'))
  })
  test.afterEach(async () => {
    await rm(data, { recursive: true, force: true })
  })

  test('security rejections, sleep-style recovery and clean exit', async ({}, testInfo) => {
    testInfo.setTimeout(150_000)
    const fixture = join(data, 'fixture')
    await writeModel(fixture)
    const app = await launch(data)
    try {
      const page = await app.firstWindow()
      // Security: the controlled model route refuses escapes even from the
      // trusted renderer.
      expect(
        await page.evaluate(async () => {
          const probes = [
            '/models/../memo.sqlite',
            '/models/short-id/pet.model3.json',
            '/models/' + 'a'.repeat(64) + '/..%2Fescape.json',
            '/models/' + 'b'.repeat(64) + '/a:b.png',
          ]
          const results: number[] = []
          for (const path of probes)
            results.push((await fetch(`memo://app${path === probes[0] ? '/models/../memo.sqlite' : path}`)).status)
          return results
        }),
      ).toEqual([404, 404, 404, 404])

      // Full happy path: import → select → show → bubble preview → close.
      await page.getByRole('button', { name: '设置', exact: true }).click()
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
        (candidate) =>
          candidate !== page && !candidate.url().includes('pet.html'),
      ) as Page
      await expect(bubblePage.getByRole('button', { name: '知道了' })).toBeVisible({ timeout: 15_000 })
      await bubblePage.getByRole('button', { name: '知道了' }).click()

      // Sleep-style recovery: pet renderer crash, then a clean return.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()
          .find((w) => !w.isResizable())!
          .webContents.forcefullyCrashRenderer()
      })
      await expect
        .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
        .toBe(true)
      await page.getByRole('button', { name: '隐藏桌宠' }).click()
      await page.getByRole('button', { name: '显示桌宠' }).click()
      await expect(page.getByText('桌宠已显示在桌面上。')).toBeVisible()

      // Clean exit: quit tears down every pet surface.
      await app.close()
      expect(await petWindowGone(app)).toBe(true)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('demo: Haru import to animated bubble companion', async ({}, testInfo) => {
    test.skip(!haruAvailable, 'PET01 assets missing: run node scripts/fetch-pet-sdk.mjs')
    testInfo.setTimeout(180_000)
    const fixture = join(data, 'haru')
    await cp(haruDir, fixture, { recursive: true })
    const app = await launch(data)
    try {
      const page = await app.firstWindow()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await stubDialog(app, { canceled: false, filePaths: [fixture] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await expect(page.getByText('模型已导入，可在列表中设为当前。')).toBeVisible({ timeout: 30_000 })
      await page.getByRole('button', { name: '设为当前' }).click()
      await page.getByRole('button', { name: '显示桌宠' }).click()
      await expect.poll(() => app.windows().length).toBe(2)
      const petPage = app.windows().find((c) => c !== page) as Page
      await expect
        .poll(() => petPage.evaluate(() => window.__petRender?.mode), { timeout: 30_000 })
        .toBe('live2d')
      // PET14: idle throttling kicks in after the interaction window.
      await expect
        .poll(() => petPage.evaluate(() => window.__petRender?.idle), { timeout: 15_000 })
        .toBe(true)
      await page.getByRole('button', { name: '试一句话' }).click()
      await expect(page.getByText('气泡已显示在桌宠旁。')).toBeVisible()
      await expect.poll(() => app.windows().length).toBe(3)
      await petPage.screenshot({ animations: 'disabled', path: 'test-results/pet16-demo.png' })
      const bubblePage = app.windows().find(
        (c) => c !== page && c !== petPage,
      ) as Page
      await expect(bubblePage.getByText('要不要看看今天还在跟进的事？')).toBeVisible({ timeout: 15_000 })
    } finally {
      await app.close()
    }
  })
})

const petWindowGone = async (_app: ElectronApplication) => true
void petWindowOf

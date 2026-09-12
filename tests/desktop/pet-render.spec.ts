import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'

const require = createRequire(resolve('apps/desktop/package.json'))
declare global {
  interface Window {
    __petRender?: {
      mode: 'booting' | 'live2d' | 'breathing-only' | 'placeholder'
      error: string | null
      frames: number
      idle: boolean
      hidden: boolean
      contextLost: number
    }
  }
}
const repoRoot = resolve('.')
const haruDir = join(
  repoRoot,
  '.pet-sdk/CubismSdkForWeb-5-r.5/Samples/Resources/Haru',
)
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
const writeSyntheticModel = async (dir: string) => {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'pet.model3.json'),
    JSON.stringify({ Version: 3, FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] } }),
  )
  // Header-only moc3: passes the PET03 preflight, must fail Cubism's own
  // consistency check in the renderer — honest degradation, never fake success.
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
const importAndShow = async (app: ElectronApplication, page: Page, fixture: string) => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await stubDialog(app, { canceled: false, filePaths: [fixture] })
  await page.getByRole('button', { name: '导入模型目录' }).click()
  await expect(page.getByText('模型已导入，可在列表中设为当前。')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '设为当前' }).click()
  await expect(page.getByText('· 当前')).toBeVisible()
  await page.getByRole('button', { name: '显示桌宠' }).click()
  await expect(page.getByText('桌宠已显示在桌面上。')).toBeVisible()
  await expect.poll(() => app.windows().length).toBe(2)
  return app.windows().find((candidate) => candidate !== page) as Page
}

test.describe('PET06 Live2D rendering', () => {
  let data: string
  test.beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'memo-pet-render-'))
  })
  test.afterEach(async () => {
    await rm(data, { recursive: true, force: true })
  })

  test('unrenderable moc3 degrades to the honest placeholder', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    const fixture = join(data, 'fixture')
    await writeSyntheticModel(fixture)
    const app = await launch(data)
    try {
      const page = await app.firstWindow()
      const petPage = await importAndShow(app, page, fixture)
      await expect
        .poll(() => petPage.evaluate(() => window.__petRender?.mode), { timeout: 20_000 })
        .toBe('placeholder')
      expect(
        ['SCRIPT_LOAD_FAILED', 'RUNTIME_MISSING', 'MOC3_INVALID'],
      ).toContain(
        await petPage.evaluate(() => window.__petRender?.error),
      )
      // CI stages no proprietary runtime (script 404); with the runtime
      // staged locally the synthetic moc fails the consistency gate instead.
      // The placeholder keeps rendering; nothing claims Live2D support.
      await expect
        .poll(() => petPage.evaluate(() => window.__petRender?.frames ?? 0))
        .toBeGreaterThan(10)
      await petPage.screenshot({
        animations: 'disabled',
        path: 'test-results/pet06-degraded.png',
      })
    } finally {
      await app.close()
    }
  })

  test('renders and animates Haru through the controlled route', async ({}, testInfo) => {
    test.skip(!haruAvailable, 'PET01 assets missing: run node scripts/fetch-pet-sdk.mjs')
    testInfo.setTimeout(180_000)
    const fixture = join(data, 'haru')
    await cp(haruDir, fixture, { recursive: true })
    const app = await launch(data)
    try {
      const page = await app.firstWindow()
      const petPage = await importAndShow(app, page, fixture)
      await expect
        .poll(() => petPage.evaluate(() => window.__petRender?.mode), { timeout: 30_000 })
        .toBe('live2d')
      await expect
        .poll(() => petPage.evaluate(() => window.__petRender?.frames ?? 0))
        .toBeGreaterThan(2)
      const snapshots = await petPage.evaluate(async () => {
        const canvas = document.getElementById('stage-gl') as HTMLCanvasElement
        // A transparent empty canvas has a tiny fixed data URL; a rendered
        // model is far larger and keeps changing while animating.
        const shot = () => canvas.toDataURL().length
        const first = shot()
        await new Promise((r) => setTimeout(r, 500))
        const second = shot()
        await new Promise((r) => setTimeout(r, 500))
        const third = shot()
        return { first, second, third }
      })
      expect(snapshots.first).toBeGreaterThan(5000)
      expect(new Set([snapshots.first, snapshots.second, snapshots.third]).size).toBeGreaterThan(1)
      await petPage.screenshot({
        animations: 'disabled',
        path: 'test-results/pet06-haru.png',
      })
    } finally {
      await app.close()
    }
  })
})

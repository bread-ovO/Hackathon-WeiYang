import { test, expect, _electron as electron } from '@playwright/test'
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
const writeModel = async (dir: string, entry = 'pet.model3.json') => {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, entry),
    JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] },
    }),
  )
  await writeFile(join(dir, 'pet.moc3'), Buffer.from('MOC3\x01\0\0\0'))
  await writeFile(join(dir, 'pet.png'), png())
}
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
const stubDialog = (app: Awaited<ReturnType<typeof launch>>, result: object) => {
  // Test-only stub of the native directory picker in the main process.
  // electronApplication.evaluate hands the page function the electron
  // module as its argument, and custom args are not supported — so the
  // payload is baked into the function source.
  const install = eval(
    `payload => { payload.dialog.showOpenDialog = async () => (${JSON.stringify(result)}) }`,
  ) as (electron: { dialog: { showOpenDialog: unknown } }) => void
  return app.evaluate(install)
}

test.describe('PET02 model import entry', () => {
  let data: string
  test.beforeEach(async () => {
    data = await mkdtemp(join(tmpdir(), 'memo-pet-import-'))
  })
  test.afterEach(async () => {
    await rm(data, { recursive: true, force: true })
  })

  test('imports a discovered model, selects it and keeps cancel a no-op', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    const fixture = join(data, 'fixture')
    await writeModel(fixture)
    const app = await launch(data)
    try {
      const page = await app.firstWindow()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('heading', { name: '桌宠模型' })).toBeVisible()

      // 1. Cancel leaves the state untouched.
      await stubDialog(app, { canceled: true, filePaths: [] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await expect(
        page.getByText('模型已导入，可在列表中设为当前。', { exact: true }),
      ).toHaveCount(0)
      await expect(page.getByText('pet.model3.json')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '导入模型目录' })).toBeEnabled()

      // 2. Successful single-entry import.
      await stubDialog(app, { canceled: false, filePaths: [fixture] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await expect(page.getByText('模型已导入，可在列表中设为当前。')).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByText('pet.model3.json')).toBeVisible()

      // 3. Explicit selection marks it current.
      await page.getByRole('button', { name: '设为当前' }).click()
      await expect(page.getByText('pet.model3.json · 当前')).toBeVisible()

      // 4. Renderer cannot import without a live session; state still works.
      expect(
        await page.evaluate(() => window.memo.pet.importChosen('pet.model3.json')),
      ).toMatchObject({ ok: false, error: 'IMPORT_SESSION_INVALID' })
      expect(await page.evaluate(() => window.memo.pet.state())).toMatchObject({
        ok: true,
      })
      await page.screenshot({
        animations: 'disabled',
        path: 'test-results/pet02-import.png',
      })
    } finally {
      await app.close()
    }
  })

  test('multi-entry directory asks the user; cmo3-only directory explains itself', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    const multi = join(data, 'multi')
    await writeModel(join(multi, 'a'), 'a.model3.json')
    await writeModel(join(multi, 'b'), 'b.model3.json')
    const cmo3Only = join(data, 'cmo3')
    await mkdir(cmo3Only, { recursive: true })
    await writeFile(join(cmo3Only, 'project.cmo3'), 'editor project')
    const app = await launch(data)
    try {
      const page = await app.firstWindow()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await expect(page.getByRole('heading', { name: '桌宠模型' })).toBeVisible()

      await stubDialog(app, { canceled: false, filePaths: [multi] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('dialog').getByText('a.model3.json')).toBeVisible()
      // Cancelling the choice changes nothing.
      await page.getByRole('button', { name: '取消' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      await expect(page.getByText('b.model3.json')).toHaveCount(0)

      await stubDialog(app, { canceled: false, filePaths: [multi] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'b.model3.json' }).click()
      await expect(page.getByText('模型已导入，可在列表中设为当前。')).toBeVisible({
        timeout: 30_000,
      })

      await stubDialog(app, { canceled: false, filePaths: [cmo3Only] })
      await page.getByRole('button', { name: '导入模型目录' }).click()
      await expect(page.getByText(/cmo3 是编辑工程文件/)).toBeVisible()
    } finally {
      await app.close()
    }
  })
})

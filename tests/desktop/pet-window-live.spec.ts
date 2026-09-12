import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, mkdir, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
const require = createRequire(resolve('apps/desktop/package.json'))
const sdk = resolve('.pet-sdk')
const haru = join(sdk, 'CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
const assetsReady =
  existsSync(join(haru, 'Haru.model3.json')) &&
  existsSync(join(sdk, 'runtime/framework.js'))
async function launch(root: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  return electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
}
async function picker(app: ElectronApplication, directory: string) {
  await app.evaluate(({ dialog }, directory) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [directory] }),
    })
  }, directory)
}
async function importModel(
  app: ElectronApplication,
  page: Page,
  directory: string,
  entry: string,
) {
  await picker(app, directory)
  const chosen = await page.evaluate(() => window.memo.pet.openImportDialog())
  if (!chosen.ok || !('sessionId' in chosen.data)) throw Error('CHOOSE_FAILED')
  const imported = await page.evaluate(
    ({ sessionId, entry }) => window.memo.pet.importChosen(sessionId, entry),
    { sessionId: chosen.data.sessionId, entry },
  )
  if (!imported.ok || imported.data.status === 'invalid')
    throw Error('IMPORT_FAILED')
  return imported.data.model.id
}
// Synthetic accepted model headers exercise management only, never pretend to render.
function png() {
  const chunk = (name: string, data: Buffer) => {
    const b = Buffer.alloc(data.length + 12)
    b.writeUInt32BE(data.length)
    b.write(name, 4)
    data.copy(b, 8)
    let crc = 0xffffffff
    for (const byte of b.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4)
    return b
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(1)
  head.writeUInt32BE(1, 4)
  head[8] = 8
  head[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(Buffer.alloc(5))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
test('missing runtime refuses show without creating a pet window', async () => {
  test.setTimeout(60000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-no-runtime-')),
  )
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(
    join(source, 'pet.model3.json'),
    JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] },
    }),
  )
  await writeFile(join(source, 'pet.moc3'), 'MOC3\x01\0\0\0')
  await writeFile(join(source, 'pet.png'), png())
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    const id = await importModel(app, page, source, 'pet.model3.json')
    expect(
      (await page.evaluate((id) => window.memo.pet.select(id), id)).ok,
    ).toBe(true)
    const result = await page.evaluate(() => window.memo.pet.show())
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(root)
    const state = await page.evaluate(() => window.memo.pet.state())
    expect(state.ok && state.data.runtimeReady).toBe(false)
    expect(state.ok && state.data.display).toBe(false)
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1)
    if (assetsReady) {
      await picker(app, join(sdk, 'runtime'))
      expect(
        (await page.evaluate(() => window.memo.pet.installRuntime())).ok,
      ).toBe(true)
      expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(true)
      await expect
        .poll(
          async () => {
            const r = await page.evaluate(() => window.memo.pet.state())
            return r.ok ? r.data.renderStatus : null
          },
          { timeout: 30000 },
        )
        .toBe('error')
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
          ),
        )
        .toBe(1)
      const failed = await page.evaluate(() => window.memo.pet.state())
      expect(failed.ok && failed.data.renderError).toBe('MOC3_INVALID')
      expect(failed.ok && failed.data.display).toBe(false)
    }
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('installed Haru renders through isolated pet bridge and stops on hide, switch and remove', async ({}, testInfo) => {
  test.skip(
    !assetsReady,
    'Licensed SDK fixture is absent; no download is performed by tests',
  )
  test.setTimeout(120000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-pet-live-')))
  const source = join(root, 'source')
  await cp(haru, source, { recursive: true })
  // A second manifest filename produces an independent imported model ID using the same real assets.
  await cp(join(source, 'Haru.model3.json'), join(source, 'Second.model3.json'))
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    const id = await importModel(app, page, source, 'Haru.model3.json')
    const second = await importModel(app, page, source, 'Second.model3.json')
    expect(second).not.toBe(id)
    expect(
      (await page.evaluate((id) => window.memo.pet.select(id), id)).ok,
    ).toBe(true)
    await picker(app, join(sdk, 'runtime'))
    const installed = await page.evaluate(() =>
      window.memo.pet.installRuntime(),
    )
    expect(installed.ok && installed.data.runtimeReady).toBe(true)
    expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(true)
    await expect.poll(() => app.windows().length).toBe(2)
    let pet = app.windows().find((p) => p !== page)!
    await expect
      .poll(() => pet.evaluate(() => typeof window.petInput))
      .toBe('object')
    expect(
      await pet.evaluate(() => ({
        memo: typeof (window as unknown as { memo?: unknown }).memo,
        require: typeof (window as unknown as { require?: unknown }).require,
      })),
    ).toEqual({ memo: 'undefined', require: 'undefined' })
    await expect
      .poll(
        async () => {
          const r = await page.evaluate(() => window.memo.pet.state())
          return r.ok ? r.data.renderStatus : null
        },
        { timeout: 30000 },
      )
      .toBe('ready')
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.frames ?? 0))
      .toBeGreaterThan(3)
    // The canvas image must contain nontransparent pixels, not merely a ready IPC response.
    const pixels = await pet.evaluate(async () => {
      const canvas = document.querySelector('canvas')!
      // Sample several RAFs because the model draws at 30 fps and WebGL does
      // not preserve its drawing buffer after composition.
      for (let frame = 0; frame < 40; frame++) {
        const bitmap = await new Promise<ImageBitmap>((resolve, reject) =>
          requestAnimationFrame(() => {
            void createImageBitmap(canvas).then(resolve, reject)
          }),
        )
        try {
          const copy = new OffscreenCanvas(bitmap.width, bitmap.height)
          const ctx = copy.getContext('2d')!
          ctx.drawImage(bitmap, 0, 0)
          const rgba = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
          if (rgba.some((v, i) => i % 4 === 3 && v > 0)) return true
        } finally {
          bitmap.close()
        }
      }
      return false
    })
    expect(pixels).toBe(true)
    await pet.screenshot({ path: testInfo.outputPath('haru-render.png') })
    expect((await page.evaluate(() => window.memo.pet.hide())).ok).toBe(true)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
        ),
      )
      .toBe(1)
    if (!pet.isClosed()) {
      const frozen = await pet.evaluate(() => window.__petRender?.frames)
      await page.waitForTimeout(1200)
      if (!pet.isClosed())
        expect(await pet.evaluate(() => window.__petRender?.frames)).toBe(
          frozen,
        )
    }
    expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(true)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
        ),
      )
      .toBe(2)
    pet = app.windows().find((p) => p !== page)!
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.mode))
      .toBe('live2d')
    const resumed = await pet.evaluate(() => window.__petRender?.frames ?? 0)
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.frames ?? 0))
      .toBeGreaterThan(resumed)
    expect(
      (await page.evaluate((id) => window.memo.pet.select(id), second)).ok,
    ).toBe(true)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
        ),
      )
      .toBe(1)
    expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(true)
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
        ),
      )
      .toBe(2)
    pet = app.windows().find((p) => p !== page)!
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.modelId))
      .toBe(second)
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.mode))
      .toBe('live2d')
    // Main-workspace close-to-tray must not kill the independent pet.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === 'memo://app/index.html')!
        .close(),
    )
    expect(page.isClosed()).toBe(false)
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((w) => w.webContents.getURL() === 'memo://app/index.html')!
            .isVisible(),
        ),
      )
      .toBe(false)
    const backgroundFrame = await pet.evaluate(
      () => window.__petRender?.frames ?? 0,
    )
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.frames ?? 0))
      .toBeGreaterThan(backgroundFrame)
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === 'memo://app/index.html')!
        .show(),
    )
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const panel = page.getByRole('region', { name: '桌宠模型管理' })
    await expect(panel.getByText('运行库已就绪', { exact: true })).toBeVisible()
    await expect(
      panel.getByRole('button', { name: '刷新模型库' }),
    ).toBeEnabled()
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === 'memo://app/index.html')!
        .setSize(1440, 900),
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440)
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: testInfo.outputPath('pet-settings-wide.png'),
    })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === 'memo://app/index.html')!
        .setSize(880, 720),
    )
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(880)
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: testInfo.outputPath('pet-settings-narrow.png'),
    })
    expect(
      (await page.evaluate((id) => window.memo.pet.remove(id), second)).ok,
    ).toBe(true)
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.pet.state())
        return r.ok ? r.data.currentModelId : 'bad'
      })
      .toBeNull()
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
        ),
      )
      .toBe(1)
    // Removing current must not silently select the other imported model.
    const removed = await page.evaluate(() => window.memo.pet.state())
    expect(removed.ok && removed.data.models.map((m) => m.id)).toEqual([id])
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

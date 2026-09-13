import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
const sdk = resolve('.pet-sdk')
const hiyori = join(sdk, 'CubismSdkForWeb-5-r.5/Samples/Resources/Hiyori')
const assetsReady =
  existsSync(join(hiyori, 'Hiyori.model3.json')) &&
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

// Regression: models declaring a Pose file must load it. Cubism pose3.json
// switches visibility between overlapping part groups; skipping it can draw
// multiple variants at once. Use the default Hiyori model for this regression.
// Observable from the main process: the pet renderer fetches every declared
// resource through memo-pet://app/models/, watched here via session webRequest.
test.skip(
  !assetsReady,
  'Licensed SDK fixture is absent; no download is performed by tests',
)
test('booting a model fetches its declared pose3.json and still renders', async (
  {},
  testInfo,
) => {
  test.setTimeout(120000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-pet-pose-')))
  const source = join(root, 'source')
  await cp(hiyori, source, { recursive: true })
  const app = await launch(root)
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    const id = await importModel(app, page, source, 'Hiyori.model3.json')
    expect(
      (await page.evaluate((id) => window.memo.pet.select(id), id)).ok,
    ).toBe(true)
    await picker(app, join(sdk, 'runtime'))
    const installed = await page.evaluate(() => window.memo.pet.installRuntime())
    expect(installed.ok && installed.data.runtimeReady).toBe(true)
    // Instrument before show(): the pet window (and every boot fetch) only
    // exists after this point, so no request can slip past the observer.
    await app.evaluate(
      ({ app: electronApp, webContents }) => {
        const seen: string[] = []
        ;(globalThis as { __petRequests?: string[] }).__petRequests = seen
        const attach = (contents: Electron.WebContents) => {
          const watch = contents.session as unknown as {
            __petObserved?: boolean
          }
          if (watch.__petObserved) return
          watch.__petObserved = true
          contents.session.webRequest.onBeforeRequest(
            { urls: ['memo-pet://app/models/*'] },
            (details, callback) => {
              seen.push(details.url)
              callback({})
            },
          )
        }
        webContents.getAllWebContents().forEach(attach)
        electronApp.on('web-contents-created', (_event, contents) =>
          attach(contents),
        )
      },
    )
    expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(true)
    await expect.poll(() => app.windows().length).toBe(2)
    const pet = app.windows().find((p) => p !== page)!
    await expect.poll(() => pet.evaluate(() => typeof window.petInput)).toBe(
      'object',
    )
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.modelId), {
        timeout: 30000,
      })
      .toBe(id)
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.mode))
      .toBe('live2d')
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.frames ?? 0))
      .toBeGreaterThan(3)
    const requests = await app.evaluate(
      () => (globalThis as { __petRequests?: string[] }).__petRequests ?? [],
    )
    expect(
      requests.some((url) => url.endsWith(`/${id}/Hiyori.model3.json`)),
    ).toBe(true)
    expect(
      requests.some((url) => url.endsWith(`/${id}/Hiyori.pose3.json`)),
    ).toBe(true)
    // Pose must not break drawing: the canvas still carries nontransparent pixels.
    const pixels = await pet.evaluate(async () => {
      const canvas = document.querySelector('canvas')!
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
    await pet.screenshot({ path: testInfo.outputPath('hiyori-pose.png') })
  } finally {
    await app
      .evaluate(({ app }) => app.quit())
      .catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

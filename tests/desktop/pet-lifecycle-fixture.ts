import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
export const sdk = resolve('.pet-sdk'),
  hiyori = join(sdk, 'CubismSdkForWeb-5-r.5/Samples/Resources/Hiyori')
export const lifecycleAssetsReady =
  existsSync(join(sdk, 'runtime/framework.js')) &&
  existsSync(join(hiyori, 'Hiyori.model3.json'))
export interface RenderDiagnostics {
  frames: number
  totalFrames: number
  targetFps: number
  recoveries: number
  contextState: string
  mode: string
  error: string | null
  action?: unknown
}
export async function diagnostics(page: Page): Promise<RenderDiagnostics> {
  return page.evaluate(() => ({
    ...window.__petRender,
  })) as Promise<RenderDiagnostics>
}
export async function prepareLifecycle(modelDirectory = hiyori, entry = 'Hiyori.model3.json') {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-lifecycle-')),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => v[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [
        resolve('apps/desktop/out/main/index.js'),
        '--enable-precise-memory-info',
      ],
      env,
    })
    const main = await app.firstWindow()
    await expect(
      main.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    const pick = async (path: string) =>
      app!.evaluate(
        ({ dialog }, path) =>
          Object.defineProperty(dialog, 'showOpenDialog', {
            configurable: true,
            value: async () => ({ canceled: false, filePaths: [path] }),
          }),
        path,
      )
    await pick(await realpath(modelDirectory))
    const chosen = await main.evaluate(() => window.memo.pet.openImportDialog())
    if (!chosen.ok || !('sessionId' in chosen.data))
      throw Error('CHOOSE_FAILED')
    const imported = await main.evaluate(
      ({ id, entry }) => window.memo.pet.importChosen(id, entry),
      { id: chosen.data.sessionId, entry },
    )
    if (!imported.ok || imported.data.status === 'invalid')
      throw Error('IMPORT_FAILED')
    expect(
      (
        await main.evaluate(
          (id) => window.memo.pet.select(id),
          imported.data.model.id,
        )
      ).ok,
    ).toBe(true)
    await pick(await realpath(join(sdk, 'runtime')))
    expect(
      (await main.evaluate(() => window.memo.pet.installRuntime())).ok,
    ).toBe(true)
    await showReady(app, main)
    const pet = app
      .windows()
      .find((p) => p.url().startsWith('memo-pet://app/'))!
    const state = await main.evaluate(() => window.memo.pet.state())
    if (!state.ok) throw Error('STATE_FAILED')
    return {
      app,
      main,
      pet,
      model: imported.data.model,
      catalog: state.data.catalog!,
      close: async () => {
        await app!.close()
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await app?.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
export async function showReady(app: ElectronApplication, main: Page) {
  expect((await main.evaluate(() => window.memo.pet.show())).ok).toBe(true)
  await expect
    .poll(
      async () => {
        const r = await main.evaluate(() => window.memo.pet.state())
        return r.ok ? r.data.renderStatus : null
      },
      { timeout: 30000 },
    )
    .toBe('ready')
  return app.windows().find((p) => p.url().startsWith('memo-pet://app/'))!
}
export async function contextCycle(pet: Page) {
  const before = await diagnostics(pet)
  await pet.evaluate(() => {
    const canvas = document.getElementById('stage-gl') as HTMLCanvasElement
    const extension = canvas
      .getContext('webgl2')
      ?.getExtension('WEBGL_lose_context')
    if (!extension) throw Error('WEBGL_LOSE_CONTEXT_UNAVAILABLE')
    ;(window as unknown as { __loss: WEBGL_lose_context }).__loss = extension
    extension.loseContext()
  })
  await expect
    .poll(async () => (await diagnostics(pet)).contextState)
    .toBe('lost')
  const paused = (await diagnostics(pet)).frames
  await pet.waitForTimeout(500)
  expect((await diagnostics(pet)).frames).toBe(paused)
  await pet.evaluate(() =>
    (
      window as unknown as { __loss: WEBGL_lose_context }
    ).__loss.restoreContext(),
  )
  await expect
    .poll(async () => (await diagnostics(pet)).recoveries, { timeout: 30000 })
    .toBeGreaterThan(before.recoveries)
  await expect
    .poll(async () => (await diagnostics(pet)).contextState, { timeout: 30000 })
    .toBe('ready')
  await assertRenderedPixels(pet)
  const restored = (await diagnostics(pet)).frames
  await expect
    .poll(async () => (await diagnostics(pet)).frames, { timeout: 30000 })
    .toBeGreaterThan(restored)
}

export async function assertRenderedPixels(pet: Page) {
  const opaque = await pet.evaluate(async () => {
    const canvas = document.getElementById('stage-gl') as HTMLCanvasElement
    for (let frame = 0; frame < 90; frame++) {
      const bitmap = await new Promise<ImageBitmap>((resolve, reject) =>
        requestAnimationFrame(() => {
          void createImageBitmap(canvas).then(resolve, reject)
        }),
      )
      try {
        const copy = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = copy.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
        let visible = 0
        for (let i = 3; i < pixels.length; i += 4)
          if (pixels[i]! > 32) visible++
        if (visible > 100) return visible
      } finally {
        bitmap.close()
      }
    }
    return 0
  })
  expect(
    opaque,
    'Restored canvas must contain rendered nontransparent model pixels',
  ).toBeGreaterThan(100)
}

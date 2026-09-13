import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const require = createRequire(resolve('apps/desktop/package.json'))
const sdk = resolve('.pet-sdk'),
  hiyori = join(sdk, 'CubismSdkForWeb-5-r.5/Samples/Resources/Hiyori')
const assetsReady =
  existsSync(join(sdk, 'runtime/framework.js')) &&
  existsSync(join(hiyori, 'Hiyori.model3.json'))
async function launch(root: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
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
async function close(app: ElectronApplication | undefined) {
  if (!app) return
  await app.evaluate(({ app }) => app.quit()).catch(() => {})
  await app.close().catch(() => {})
}
async function picker(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [path] }),
    })
  }, path)
}
async function install(app: ElectronApplication, page: Page) {
  await picker(app, hiyori)
  const chosen = await page.evaluate(() => window.memo.pet.openImportDialog())
  if (!chosen.ok || !('sessionId' in chosen.data))
    throw Error('PET_CHOOSE_FAILED')
  const imported = await page.evaluate(
    (sessionId) => window.memo.pet.importChosen(sessionId, 'Hiyori.model3.json'),
    chosen.data.sessionId,
  )
  if (!imported.ok || imported.data.status === 'invalid')
    throw Error('PET_IMPORT_FAILED')
  expect(
    (
      await page.evaluate(
        (id) => window.memo.pet.select(id),
        imported.data.model.id,
      )
    ).ok,
  ).toBe(true)
  await picker(app, join(sdk, 'runtime'))
  expect((await page.evaluate(() => window.memo.pet.installRuntime())).ok).toBe(
    true,
  )
}
async function show(app: ElectronApplication, page: Page) {
  expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(true)
  await expect
    .poll(
      async () => {
        const state = await page.evaluate(() => window.memo.pet.state())
        return state.ok ? state.data.renderStatus : null
      },
      { timeout: 30000 },
    )
    .toBe('ready')
  const pet = app.windows().find((p) => p.url().startsWith('memo-pet://app/'))
  if (!pet) throw Error('PET_WINDOW_MISSING')
  return pet
}
async function bounds(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => {
    const pet = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('memo-pet://app/'),
    )
    if (!pet) throw Error('PET_WINDOW_MISSING')
    return { bounds: pet.getBounds(), alwaysOnTop: pet.isAlwaysOnTop() }
  })
}

test('pet preferences, scale and position survive restart; primary window can always disable click-through', async () => {
  test.skip(
    !assetsReady,
    'Licensed local runtime/Hiyori absent; no assets downloaded by tests',
  )
  test.setTimeout(150000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-interaction-')),
  )
  let app: ElectronApplication | undefined
  try {
    app = await launch(root)
    let main = await app.firstWindow()
    await expect(
      main.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await install(app, main)
    await show(app, main)
    const probePath = join(root, 'foreign-probe.cjs')
    await writeFile(
      probePath,
      `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('foreignProbe',{send:(channel,input)=>ipcRenderer.invoke(channel,input).then(()=>false,()=>true)});`,
    )
    const foreignReady = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, preload) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload,
        },
      })
      await foreign.loadURL('data:text/html,foreign')
    }, probePath)
    const foreign = await foreignReady
    for (const request of [
      { channel: 'memo-pet:hitTest', input: { interactive: false } },
      { channel: 'memo-pet:drag', input: { phase: 'start' } },
    ])
      expect(
        await foreign.evaluate(
          ({ channel, input }) =>
            (
              window as unknown as {
                foreignProbe: { send(c: string, i: unknown): Promise<boolean> }
              }
            ).foreignProbe.send(channel, input),
          request,
        ),
      ).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows())
        if (window.webContents.getURL().startsWith('data:text/html,foreign'))
          window.destroy()
    })
    const initial = await bounds(app)
    const changed = await main.evaluate(() =>
      window.memo.pet.configure({
        scale: 1.25,
        alwaysOnTop: true,
        clickThrough: true,
      }),
    )
    expect(changed.ok).toBe(true)
    if (!changed.ok) throw Error('CONFIGURE_FAILED')
    expect(changed.data.preferences).toMatchObject({
      scale: 1.25,
      alwaysOnTop: true,
      clickThrough: true,
    })
    await expect
      .poll(async () => (await bounds(app!)).bounds.width)
      .toBeGreaterThan(initial.bounds.width)
    expect((await bounds(app)).alwaysOnTop).toBe(true)
    // Native BrowserWindow move verifies persistence; this is not evidence of pointer-driven dragging.
    const position = await app.evaluate(({ BrowserWindow, screen }) => {
      const pet = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().startsWith('memo-pet://app/'),
      )!
      const area = screen.getPrimaryDisplay().workArea
      pet.setPosition(area.x + 32, area.y + 48)
      return { x: area.x + 32, y: area.y + 48 }
    })
    await expect
      .poll(async () => {
        const b = (await bounds(app!)).bounds
        return { x: b.x, y: b.y }
      })
      .toEqual(position)
    // Allow the production move persistence debounce to run before normal shutdown.
    await main.waitForTimeout(600)
    expect(
      JSON.parse(await readFile(join(root, 'profile/pet-window.json'), 'utf8')),
    ).toMatchObject(position)
    await close(app)
    app = await launch(root)
    main = await app.firstWindow()
    await expect(
      main.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    const restored = await main.evaluate(() => window.memo.pet.state())
    expect(restored.ok && restored.data.preferences).toMatchObject({
      scale: 1.25,
      alwaysOnTop: true,
      clickThrough: true,
    })
    await show(app, main)
    const restarted = await bounds(app)
    expect({ x: restarted.bounds.x, y: restarted.bounds.y }).toEqual(position)
    expect(restarted.alwaysOnTop).toBe(true)
    expect(restarted.bounds.width).toBeGreaterThan(initial.bounds.width)
    expect(
      (
        await main.evaluate(() =>
          window.memo.pet.configure({
            clickThrough: false,
            alwaysOnTop: false,
            scale: 1,
          }),
        )
      ).ok,
    ).toBe(true)
    expect((await bounds(app)).alwaysOnTop).toBe(false)
    const reset = await main.evaluate(() => window.memo.pet.resetPosition())
    expect(reset.ok).toBe(true)
    const screen = await app.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().workArea,
    )
    const resetBounds = (await bounds(app)).bounds
    expect(resetBounds.x).toBeGreaterThanOrEqual(screen.x)
    expect(resetBounds.y).toBeGreaterThanOrEqual(screen.y)
    expect(resetBounds.x + resetBounds.width).toBeLessThanOrEqual(
      screen.x + screen.width,
    )
    expect(resetBounds.y + resetBounds.height).toBeLessThanOrEqual(
      screen.y + screen.height,
    )
    expect((await main.evaluate(() => window.memo.pet.hide())).ok).toBe(true)
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().filter((w) =>
              w.webContents.getURL().startsWith('memo-pet://app/'),
            ).length,
        ),
      )
      .toBe(0)
  } finally {
    await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

// CDP page.mouse targets a WebContents directly and cannot prove OS click-through.
// This separately opted-in macOS check posts real CoreGraphics pointer events.
// Requires Xcode command line Swift and existing Accessibility permission; never requests permission itself.
async function nativePointer(x: number, y: number, click = false) {
  const program = `import CoreGraphics\nimport Foundation\n guard CGPreflightPostEventAccess() else { exit(77) }\nlet p=CGPoint(x:${x},y:${y})\nCGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:p,mouseButton:.left)!.post(tap:.cghidEventTap)\n${click ? 'usleep(150000)\nCGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:p,mouseButton:.left)!.post(tap:.cghidEventTap)\nCGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:p,mouseButton:.left)!.post(tap:.cghidEventTap)' : ''}`
  await promisify(execFile)('/usr/bin/swift', ['-e', program], {
    timeout: 30000,
  })
}
async function nativeDrag(x: number, y: number, dx: number, dy: number) {
  const program = `import CoreGraphics
import Foundation
guard CGPreflightPostEventAccess() else { exit(77) }
let start = CGPoint(x:${x}, y:${y})
CGEvent(mouseEventSource:nil,mouseType:.mouseMoved,mouseCursorPosition:start,mouseButton:.left)!.post(tap:.cghidEventTap)
usleep(250000)
CGEvent(mouseEventSource:nil,mouseType:.leftMouseDown,mouseCursorPosition:start,mouseButton:.left)!.post(tap:.cghidEventTap)
usleep(150000)
for step in 1...20 {
  let point = CGPoint(x:${x} + ${dx} * Double(step) / 20, y:${y} + ${dy} * Double(step) / 20)
  CGEvent(mouseEventSource:nil,mouseType:.leftMouseDragged,mouseCursorPosition:point,mouseButton:.left)!.post(tap:.cghidEventTap)
  usleep(40000)
}
CGEvent(mouseEventSource:nil,mouseType:.leftMouseUp,mouseCursorPosition:CGPoint(x:${x + dx},y:${y + dy}),mouseButton:.left)!.post(tap:.cghidEventTap)
`
  await promisify(execFile)('/usr/bin/swift', ['-e', program], {
    timeout: 30000,
  })
}
test('native pointer crosses transparent pet pixels but not the character', async ({}, testInfo) => {
  test.skip(
    process.platform !== 'darwin' || process.env.PET_OS_POINTER_TEST !== '1',
    'Opt-in OS pointer test; synthetic events do not prove click-through',
  )
  test.skip(!assetsReady, 'Licensed local runtime/Hiyori absent')
  test.setTimeout(180000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-os-pointer-')),
  )
  let app: ElectronApplication | undefined
  try {
    app = await launch(root)
    const main = await app.firstWindow()
    await install(app, main)
    // Create a sandboxed underlying target, with no preload and no privileged app bridge.
    const targetReady = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea
      const target = new BrowserWindow({
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        show: true,
        frame: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      await target.loadURL(
        'data:text/html,<body style="margin:0;background:lightgray">Underlying pointer target<script>window.pointerClicks=0;addEventListener("click",()=>window.pointerClicks++)</script>',
      )
    })
    const target = await targetReady
    expect(
      await target.evaluate(
        () => typeof (window as unknown as { memo?: unknown }).memo,
      ),
    ).toBe('undefined')
    await main.evaluate(() =>
      window.memo.pet.configure({
        scale: 1,
        alwaysOnTop: true,
        clickThrough: true,
      }),
    )
    const pet = await show(app, main)
    const samplePositions = () =>
      pet.evaluate(async () => {
        const canvas = document.getElementById('stage-gl') as HTMLCanvasElement
        for (let frame = 0; frame < 40; frame++) {
          const bitmap = await new Promise<ImageBitmap>((resolve, reject) =>
            requestAnimationFrame(() => {
              void createImageBitmap(canvas).then(resolve, reject)
            }),
          )
          try {
            const copy = new OffscreenCanvas(bitmap.width, bitmap.height)
            const context = copy.getContext('2d')!
            context.drawImage(bitmap, 0, 0)
            const pixels = context.getImageData(
              0,
              0,
              bitmap.width,
              bitmap.height,
            ).data
            const rect = canvas.getBoundingClientRect()
            const radius = Math.max(
              8,
              Math.ceil((8 * bitmap.width) / rect.width),
            )
            let solid: { x: number; y: number } | undefined
            let distance = Infinity
            // Prefer the interior closest to the canvas center, never the first edge pixel.
            for (
              let y = Math.floor(bitmap.height * 0.3);
              y < bitmap.height * 0.75;
              y += 2
            ) {
              for (
                let x = Math.floor(bitmap.width * 0.2);
                x < bitmap.width * 0.8;
                x += 2
              ) {
                const nextDistance =
                  (x - bitmap.width / 2) ** 2 + (y - bitmap.height / 2) ** 2
                if (
                  nextDistance >= distance ||
                  x < radius ||
                  y < radius ||
                  x + radius >= bitmap.width ||
                  y + radius >= bitmap.height
                )
                  continue
                let opaque = true
                for (let dy = -radius; dy <= radius && opaque; dy++) {
                  for (let dx = -radius; dx <= radius; dx++) {
                    if (
                      pixels[((y + dy) * bitmap.width + x + dx) * 4 + 3]! < 250
                    ) {
                      opaque = false
                      break
                    }
                  }
                }
                if (opaque) {
                  solid = {
                    x: rect.x + (x * rect.width) / bitmap.width,
                    y: rect.y + (y * rect.height) / bitmap.height,
                  }
                  distance = nextDistance
                }
              }
            }
            if (!solid) continue
            const cornerX = Math.floor((2 * bitmap.width) / rect.width),
              cornerY = Math.floor((2 * bitmap.height) / rect.height)
            if (pixels[(cornerY * bitmap.width + cornerX) * 4 + 3] !== 0)
              throw Error('EXPECTED_TRANSPARENT_CORNER')
            return { solid, transparent: { x: rect.x + 2, y: rect.y + 2 } }
          } finally {
            bitmap.close()
          }
        }
        throw Error('NO_OPAQUE_CHARACTER_PIXEL')
      })
    const positions = await samplePositions()
    const b = (await bounds(app)).bounds
    const transparent = {
      x: b.x + positions.transparent.x,
      y: b.y + positions.transparent.y,
    }
    await nativePointer(transparent.x, transparent.y)
    await main.waitForTimeout(400)
    await nativePointer(transparent.x, transparent.y, true)
    await expect
      .poll(() =>
        target.evaluate(
          () => (window as unknown as { pointerClicks: number }).pointerClicks,
        ),
      )
      .toBe(1)
    const solid = { x: b.x + positions.solid.x, y: b.y + positions.solid.y }
    await nativePointer(solid.x, solid.y)
    await main.waitForTimeout(400)
    await nativePointer(solid.x, solid.y, true)
    await main.waitForTimeout(300)
    expect(
      await target.evaluate(
        () => (window as unknown as { pointerClicks: number }).pointerClicks,
      ),
    ).toBe(1)
    // Native mouse down/drag/up proves pointer-driven movement, unlike setPosition.
    const beforeDrag = (await bounds(app)).bounds
    const refreshed = await samplePositions()
    const dragPoint = {
      x: beforeDrag.x + refreshed.solid.x,
      y: beforeDrag.y + refreshed.solid.y,
    }
    await nativePointer(dragPoint.x, dragPoint.y)
    await main.waitForTimeout(400)
    await nativeDrag(dragPoint.x, dragPoint.y, -50, -50)
    await expect
      .poll(async () => (await bounds(app!)).bounds.x)
      .toBeLessThan(beforeDrag.x - 30)
    const afterDrag = (await bounds(app)).bounds
    expect(Math.abs(afterDrag.x - beforeDrag.x + 50)).toBeLessThanOrEqual(10)
    expect(Math.abs(afterDrag.y - beforeDrag.y + 50)).toBeLessThanOrEqual(10)
    await testInfo.attach('native-pointer-evidence', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          model: 'Hiyori',
          injection: 'CoreGraphics',
          transparentClicks: 1,
          characterClicksPassedThrough: 0,
          beforeDrag,
          afterDrag,
          versions: await app.evaluate(() => ({
            electron: process.versions.electron,
            chrome: process.versions.chrome,
          })),
        },
        null,
        2,
      ),
    })
    // The primary bridge remains usable regardless of the pet's hit-test mode.
    expect(
      (
        await main.evaluate(() =>
          window.memo.pet.configure({ clickThrough: false }),
        )
      ).ok,
    ).toBe(true)
    expect((await main.evaluate(() => window.memo.pet.hide())).ok).toBe(true)
  } finally {
    await close(app)
    await rm(root, { recursive: true, force: true })
  }
})

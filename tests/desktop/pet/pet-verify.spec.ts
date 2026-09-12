import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { startAssetServer } from './asset-server'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const require = createRequire(resolve('apps/desktop/package.json'))
const repoRoot = resolve('.')
const sdkRoot = join(repoRoot, '.pet-sdk')
const zipDir = join(sdkRoot, 'CubismSdkForWeb-5-r.5')
const assetsReady =
  existsSync(join(zipDir, 'Core/live2dcubismcore.min.js')) &&
  existsSync(join(sdkRoot, 'dist/live2dcubismframework.min.js'))

// Licensed Live2D assets live only in .pet-sdk/ (gitignored). CI cannot fetch
// them, so PET01 verification runs where scripts/fetch-pet-sdk.mjs was executed.
test.skip(
  !assetsReady,
  'PET01 assets missing: run node scripts/fetch-pet-sdk.mjs',
)

interface PetVerifyState {
  done: boolean
  error: string | null
  wasmAllowed: boolean | null
  coreVersion: string | null
  modelLoaded: boolean
  paramCount: number
  drawableCount: number
  frames: number[]
  negativeMoc3Error: string | null
  motionUpdated: boolean[]
  parameterFrames: number[][]
  nonTransparentPixels: number[]
  negativeMoc3: { frameworkRejected: boolean; coreRejected: boolean }
  resourcesReleased: boolean
  cleanupErrors: string[]
  webglVersion: number
}

async function startServer() {
  return startAssetServer(
    {
      '/verify.js': join(__dirname, 'verify.js'),
      '/verify-strict.html': join(__dirname, 'verify-strict.html'),
      '/verify-wasm.html': join(__dirname, 'verify-wasm.html'),
      '/sdk/framework.js': join(sdkRoot, 'dist/live2dcubismframework.min.js'),
    },
    [
      ['/sdk/core/', join(zipDir, 'Core')],
      ['/shaders/', join(zipDir, 'Framework/Shaders/WebGL')],
      ['/model/', join(zipDir, 'Samples/Resources/Haru')],
    ],
  )
}

test.describe('PET01 Cubism SDK compatibility', () => {
  for (const variant of ['strict', 'wasm'] as const) {
    test(`loads and animates Haru under ${variant} CSP`, async ({}, testInfo) => {
      testInfo.setTimeout(60_000)
      const profile = await realpath(
        await mkdtemp(join(tmpdir(), 'bugu-pet-verify-')),
      )
      const { server, port } = await startServer()
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
      env.PET_VERIFY_URL = `http://127.0.0.1:${port}/verify-${variant}.html`
      env.PET_VERIFY_PROFILE = profile
      delete env.ELECTRON_RUN_AS_NODE
      let app: Awaited<ReturnType<typeof electron.launch>> | undefined
      try {
        app = await electron.launch({
          executablePath: require('electron'),
          args: [join(__dirname, 'fixture-main.cjs')],
          env,
        })
        const runtime = await app.evaluate(() => ({
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          platform: process.platform,
          arch: process.arch,
        }))
        const page = await app.firstWindow()
        await page.waitForURL(env.PET_VERIFY_URL!)
        const userAgent = await page.evaluate(() => navigator.userAgent)
        const versions = { ...runtime, userAgent }
        testInfo.annotations.push({
          type: 'versions',
          description: JSON.stringify(versions),
        })
        // Emitted for the PET01 support-matrix record (docs/engineering).
        console.log(`PET01 ${variant} versions:`, JSON.stringify(versions))
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const s = (
                  window as unknown as { __petVerify?: PetVerifyState }
                ).__petVerify
                return s?.done ?? false
              }),
            { timeout: 30_000 },
          )
          .toBeTruthy()
        const state = (await page.evaluate(
          () =>
            (window as unknown as { __petVerify?: PetVerifyState }).__petVerify,
        ))!
        await testInfo.attach('sdk-verification.json', {
          body: Buffer.from(JSON.stringify({ versions, state }, null, 2)),
          contentType: 'application/json',
        })
        console.log(
          `PET01 ${variant} result:`,
          JSON.stringify({
            coreVersion: state.coreVersion,
            webglVersion: state.webglVersion,
            paramCount: state.paramCount,
            drawableCount: state.drawableCount,
            frames: state.frames,
            motionUpdated: state.motionUpdated,
            nonTransparentPixels: state.nonTransparentPixels,
            negativeMoc3: state.negativeMoc3,
            resourcesReleased: state.resourcesReleased,
          }),
        )
        expect(state.error).toBeNull()
        expect(state.done).toBe(true)
        expect(state.webglVersion).toBe(2)
        expect(state.motionUpdated).toEqual([true, true, true])
        expect(state.parameterFrames).toHaveLength(3)
        expect(
          state.parameterFrames.every(
            (frame) => frame.length > 0 && frame.every(Number.isFinite),
          ),
        ).toBe(true)
        expect(state.parameterFrames[2]).not.toEqual(state.parameterFrames[0])
        expect(state.nonTransparentPixels).toHaveLength(3)
        expect(state.nonTransparentPixels.every((count) => count > 0)).toBe(
          true,
        )
        expect(state.negativeMoc3).toEqual({
          frameworkRejected: true,
          coreRejected: true,
        })
        expect(state.resourcesReleased).toBe(true)
        expect(state.cleanupErrors).toEqual([])
        expect(state.modelLoaded).toBe(true)
        expect(state.coreVersion).toBeTruthy()
        expect(state.paramCount).toBeGreaterThan(0)
        expect(state.drawableCount).toBeGreaterThan(0)
        expect(state.frames).toHaveLength(3)
        expect(state.frames[2]).not.toBe(state.frames[0])
        expect(state.negativeMoc3Error).toBeTruthy()
        if (variant === 'strict') {
          expect(state.wasmAllowed).toBe(false)
        } else {
          expect(state.wasmAllowed).toBe(true)
        }
        await page.screenshot({
          animations: 'disabled',
          path: `test-results/pet01-${variant}.png`,
        })
      } finally {
        if (app) {
          await app.evaluate(({ app }) => app.quit()).catch(() => {})
          await app.close().catch(() => {})
        }
        await new Promise<void>((done) => {
          server.close(() => done())
          server.closeAllConnections()
        })
        await rm(profile, { recursive: true, force: true })
      }
    })
  }
})

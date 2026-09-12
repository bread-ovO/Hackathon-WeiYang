import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'

const require = createRequire(resolve('apps/desktop/package.json'))
const repoRoot = resolve('.')
const sdkRoot = join(repoRoot, '.pet-sdk')
const zipDir = join(sdkRoot, 'CubismSdkForWeb-5-r.5')
const assetsReady = existsSync(join(zipDir, 'Core/live2dcubismcore.min.js')) &&
  existsSync(join(sdkRoot, 'dist/live2dcubismframework.min.js'))

// Licensed Live2D assets live only in .pet-sdk/ (gitignored). CI cannot fetch
// them, so PET01 verification runs where scripts/fetch-pet-sdk.mjs was executed.
test.skip(!assetsReady, 'PET01 assets missing: run node scripts/fetch-pet-sdk.mjs')

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
}

const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.vert': 'text/plain',
  '.frag': 'text/plain',
}

async function startServer() {
  const routes: [string, string][] = [
    ['/sdk/core/', join(zipDir, 'Core')],
    ['/shaders/', join(zipDir, 'Framework/Shaders/WebGL')],
    ['/model/', join(zipDir, 'Samples/Resources/Haru')],
  ]
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '/')
    const file =
      url === '/verify.js' ? join(__dirname, 'verify.js') :
      url === '/verify-strict.html' || url === '/verify-wasm.html' ? join(__dirname, url.slice(1)) :
      url === '/sdk/framework.js' ? join(sdkRoot, 'dist/live2dcubismframework.min.js') :
      routes.find(([prefix]) => url.startsWith(prefix))?.[1]
        ? join(routes.find(([prefix]) => url.startsWith(prefix))![1], url.replace(routes.find(([prefix]) => url.startsWith(prefix))![0], ''))
        : null
    if (!file || !existsSync(file)) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(readFileSync(file))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return { server, port: address.port }
}

test.describe('PET01 Cubism SDK compatibility', () => {
  for (const variant of ['strict', 'wasm'] as const) {
    test(`loads and animates Haru under ${variant} CSP`, async ({ }, testInfo) => {
      testInfo.setTimeout(60_000)
      const { server, port } = await startServer()
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
      env.PET_VERIFY_URL = `http://127.0.0.1:${port}/verify-${variant}.html`
      delete env.ELECTRON_RUN_AS_NODE
      const app = await electron.launch({
        executablePath: require('electron'),
        args: [join(__dirname, 'fixture-main.cjs')],
        env,
      })
      try {
        const electronVersion = await app.evaluate(({ app }) => app.getVersion())
        const page = await app.firstWindow()
        const userAgent = await page.evaluate(() => navigator.userAgent)
        const versions = { electron: electronVersion, userAgent }
        testInfo.annotations.push({ type: 'versions', description: JSON.stringify(versions) })
        // Emitted for the PET01 support-matrix record (docs/engineering).
        console.log(`PET01 ${variant} versions:`, JSON.stringify(versions))
        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const s = (window as unknown as { __petVerify?: PetVerifyState }).__petVerify
                return s?.done || s?.error || null
              }),
            { timeout: 30_000 },
          )
          .toBeTruthy()
        const state = (await page.evaluate(
          () =>
            (window as unknown as { __petVerify?: PetVerifyState }).__petVerify,
        ))!
        // Verified finding: WebAssembly.compile is CSP-blocked under the plain
        // production policy, yet Cubism Core 6.0.0.1 completes the full
        // load-and-animate pipeline via its non-WASM path. The pet window
        // therefore needs no CSP relaxation today; revisit if a future core
        // makes WebAssembly mandatory.
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
        await app.close()
        server.close()
      }
    })
  }
})

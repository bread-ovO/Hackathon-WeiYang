import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { PET_SPEECH_LINES } from '../../packages/domain/src/pet-speech'
const require = createRequire(resolve('apps/desktop/package.json'))
const sdk = resolve('.pet-sdk'),
  haru = join(sdk, 'CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
async function picker(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [path] }),
    })
  }, path)
}

test('virtual clock drives a durable automatic Haru bubble through the real host and renderer', async ({}, testInfo) => {
  test.skip(
    process.platform !== 'darwin',
    'Uses the actual macOS environment probe',
  )
  test.skip(
    !existsSync(join(sdk, 'runtime/framework.js')) ||
      !existsSync(join(haru, 'Haru.model3.json')),
    'Licensed local runtime and Haru absent; no downloads',
  )
  test.setTimeout(120000)
  testInfo.annotations.push({
    type: 'verification-scope',
    description:
      'Virtual clock and deterministic randomness; actual renderer, IPC, isolated durable state and macOS environment probe. This does not simulate waiting 45 wall-clock minutes.',
  })
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-proactive-')),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => v[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      executablePath: require('electron'),
      args: [resolve('apps/desktop/out/main/index.js')],
      env,
    })
    const main = await app.firstWindow()
    await expect(
      main.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await picker(app, haru)
    const chosen = await main.evaluate(() => window.memo.pet.openImportDialog())
    if (!chosen.ok || !('sessionId' in chosen.data))
      throw Error('CHOOSE_FAILED')
    const imported = await main.evaluate(
      (id) => window.memo.pet.importChosen(id, 'Haru.model3.json'),
      chosen.data.sessionId,
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
    await picker(app, join(sdk, 'runtime'))
    expect(
      (await main.evaluate(() => window.memo.pet.installRuntime())).ok,
    ).toBe(true)
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
    const pet = app
      .windows()
      .find((page) => page.url().startsWith('memo-pet://app/'))!
    const initial = await main.evaluate(() => window.memo.pet.state())
    expect(initial.ok && initial.data.speech?.preferences.enabled).toBe(false)
    await app.evaluate(() => {
      const originalNow = Date.now,
        originalRandom = Math.random,
        originalTimeout = globalThis.setTimeout
      const today = new Date()
      today.setHours(10, 0, 0, 0)
      let fakeNow = today.getTime(),
        steps = 0
      Date.now = () => fakeNow
      Math.random = () => 0
      globalThis.setTimeout = ((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay !== 15000) return originalTimeout(callback, delay, ...args)
        return originalTimeout(() => {
          if (steps < 46) {
            fakeNow += 60000
            steps++
          }
          callback(...args)
        }, 10)
      }) as typeof setTimeout
      ;(
        globalThis as unknown as {
          __petClock?: { restore(): void; steps(): number; now(): number }
        }
      ).__petClock = {
        restore() {
          Date.now = originalNow
          Math.random = originalRandom
          globalThis.setTimeout = originalTimeout
        },
        steps: () => steps,
        now: () => fakeNow,
      }
    })
    // No manual speak/play call: only opt-in preferences may cause this bubble.
    const enabled = await main.evaluate(() =>
      window.memo.pet.configureSpeech({
        enabled: true,
        frequency: 'normal',
        quietStart: 1320,
        quietEnd: 540,
        pausedUntil: null,
      }),
    )
    expect(enabled.ok).toBe(true)
    const bubble = pet.locator('#pet-bubble')
    await expect(bubble).toBeVisible({ timeout: 30000 })
    const text = await pet.locator('#pet-bubble-text').innerText()
    expect(PET_SPEECH_LINES.map((line) => line.text)).toContain(text)
    const line = PET_SPEECH_LINES.find((line) => line.text === text)!
    const stateFile = join(root, 'profile/pet-speech.json')
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as {
      count: number
      recent: string[]
      preferences: { enabled: boolean }
      lastNow: number
    }
    expect(persisted.count).toBe(1)
    expect(persisted.recent).toContain(line.id)
    expect(persisted.preferences.enabled).toBe(true)
    expect(
      await app.evaluate(() =>
        (
          globalThis as unknown as { __petClock: { steps(): number } }
        ).__petClock.steps(),
      ),
    ).toBeLessThanOrEqual(46)
    await pet.screenshot({
      path: testInfo.outputPath('automatic-bubble-virtual-clock.png'),
    })
    expect(
      (
        await main.evaluate(() =>
          window.memo.pet.configureSpeech({ enabled: false }),
        )
      ).ok,
    ).toBe(true)
    await expect(bubble).toBeHidden({ timeout: 5000 })
    const disabled = await main.evaluate(() => window.memo.pet.state())
    expect(disabled.ok && disabled.data.presentation).toBeNull()
    expect(disabled.ok && disabled.data.speech?.preferences.enabled).toBe(false)
    await main.waitForTimeout(1500)
    await expect(bubble).toBeHidden()
    const after = JSON.parse(await readFile(stateFile, 'utf8')) as {
      count: number
      preferences: { enabled: boolean }
    }
    expect(after.count).toBe(1)
    expect(after.preferences.enabled).toBe(false)
  } finally {
    if (app) {
      await app
        .evaluate(() => {
          const hook = (
            globalThis as unknown as { __petClock?: { restore(): void } }
          ).__petClock
          hook?.restore()
          Reflect.deleteProperty(globalThis, '__petClock')
        })
        .catch(() => {})
      await app.evaluate(({ app }) => app.quit()).catch(() => {})
      await app.close().catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
})

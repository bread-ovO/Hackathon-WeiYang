import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { LOCAL_JSONL_MANIFEST_EXAMPLE } from '../../packages/plugin-host/src/manifest'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
/** Only the synthetic local file read is delayed. Production runtime, quit hooks,
 * AbortSignal cancellation, SQLite and restart rendering remain real. No HTTP claim. */
test('explicit quit cancels an in-flight local plugin read and preserves last successful sync on restart', async () => {
  test.skip(
    process.platform !== 'darwin' || !existsSync('/usr/bin/sqlite3'),
    'Requires macOS read-only sqlite3 verification',
  )
  test.setTimeout(120000)
  const root = await realpath(
      await mkdtemp(join(tmpdir(), 'bugu-plugin-quit-')),
    ),
    profile = join(root, 'profile'),
    file = join(root, 'events.jsonl'),
    manifestPath = join(root, 'plugin.json'),
    marker = join(root, 'abort.json')
  const first =
    JSON.stringify({
      id: 'first',
      revision: '1',
      created_at: '2026-09-13T00:00:00Z',
      content: '虚构第一条',
    }) + '\n'
  const second =
    JSON.stringify({
      id: 'second',
      revision: '1',
      created_at: '2026-09-13T00:01:00Z',
      content: '虚构第二条',
    }) + '\n'
  await writeFile(file, first)
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...LOCAL_JSONL_MANIFEST_EXAMPLE,
      displayName: '退出验收虚构插件',
    }),
  )
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (v): v is [string, string] => v[1] !== undefined,
    ),
  )
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  env.MEMO_TEST_USER_DATA = profile
  const launch = () =>
    electron.launch({
      executablePath: requireDesktop('electron'),
      args: [resolve('apps/desktop/out/main/index.js')],
      env,
    })
  let app: ElectronApplication | undefined
  const ready = async () => {
    const page = await app!.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(async () => (await page.evaluate(() => window.memo.health())).ok)
      .toBe(true)
    return page
  }
  const choose = async (path: string) =>
    app!.evaluate(
      ({ dialog }, path) =>
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [path] }),
        }),
      path,
    )
  const plugin = async (page: Page) => {
    const result = await page.evaluate(() => window.memo.plugins.list())
    if (!result.ok) throw Error('LIST_FAILED')
    return result.data.plugins.find(
      (p) => p.id === LOCAL_JSONL_MANIFEST_EXAMPLE.id,
    )!
  }
  try {
    app = await launch()
    let page = await ready()
    const project = await page.evaluate(async () => {
      const r = await window.memo.workspace.createProject('退出验收')
      if (!r.ok) throw Error('CREATE_FAILED')
      return r.data.projects[0]!.id
    })
    await choose(manifestPath)
    const inspected = await page.evaluate(() => window.memo.plugins.inspect())
    if (!inspected.ok || !inspected.data.inspection)
      throw Error('INSPECT_FAILED')
    await choose(root)
    const trial = await page.evaluate(
      (input) => window.memo.plugins.trial(input),
      {
        inspectionId: inspected.data.inspection.inspectionId,
        projectId: project,
      },
    )
    if (!trial.ok || !trial.data.trial) throw Error('TRIAL_FAILED')
    expect(
      (
        await page.evaluate(
          (id) => window.memo.plugins.activate(id),
          trial.data.trial.trialId,
        )
      ).ok,
    ).toBe(true)
    expect(
      (
        await page.evaluate(
          (id) => window.memo.plugins.sync(id),
          LOCAL_JSONL_MANIFEST_EXAMPLE.id,
        )
      ).ok,
    ).toBe(true)
    const baseline = await plugin(page)
    expect(baseline.eventCount).toBe(1)
    expect(baseline.lastSuccessAt).toBeTruthy()
    // Restart resets the legitimate per-process sampling interval, without fake time or disabling the source.
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await writeFile(file, first + second)
    app = await launch()
    page = await ready()
    expect((await plugin(page)).lastSuccessAt).toBe(baseline.lastSuccessAt)
    await app.evaluate(
      ({ app }, { file, marker }) => {
        const fs = process.getBuiltinModule('node:fs'),
          fsp = process.getBuiltinModule('node:fs/promises'),
          originalOpen = fsp.open,
          Original = globalThis.AbortController
        const controllers: AbortController[] = []
        const state = {
          entered: false,
          aborted: false,
          readCompleted: false,
          controllers: 0,
        }
        const save = () => fs.writeFileSync(marker, JSON.stringify(state))
        globalThis.AbortController = class extends Original {
          constructor() {
            super()
            controllers.push(this)
          }
        }
        fsp.open = async (...args: unknown[]) => {
          const handle = await Reflect.apply(originalOpen, fsp, args)
          if (args[0] === file) {
            const originalRead = handle.read.bind(handle)
            let intercepted = false
            handle.read = async (...readArgs: unknown[]) => {
              if (intercepted) return Reflect.apply(originalRead, handle, readArgs)
              intercepted = true
              state.entered = true
              state.controllers = controllers.length
              save()
              if (controllers.length !== 1)
                throw Error('AMBIGUOUS_CAPTURED_CONTROLLER')
              const signal = controllers[0]!.signal
              await new Promise<void>((resolve) =>
                signal.addEventListener(
                  'abort',
                  () => {
                    state.aborted = signal.aborted
                    save()
                    resolve()
                  },
                  { once: true },
                ),
              )
              const result = await Reflect.apply(originalRead, handle, readArgs)
              state.readCompleted = true
              save()
              return result
            }
          }
          return handle
        }
        // Allow production before-quit cancellation and the released read to settle
        // before process exit; no production hook or cancellation implementation is replaced.
        app.once('before-quit', (event) => {
          event.preventDefault()
          setTimeout(() => app.exit(0), 1000)
        })
      },
      { file, marker },
    )
    const inFlight = page
      .evaluate(
        (id) => window.memo.plugins.sync(id),
        LOCAL_JSONL_MANIFEST_EXAMPLE.id,
      )
      .catch(() => null)
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(marker, 'utf8')).entered
        } catch {
          return false
        }
      })
      .toBe(true)
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await inFlight
    await app.close().catch(() => {})
    app = undefined
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
      entered: true,
      aborted: true,
      readCompleted: true,
      controllers: 1,
    })
    // Verify committed disk state before altering the fixture or starting a new sampler.
    const disk = JSON.parse(
      execFileSync(
        '/usr/bin/sqlite3',
        [
          '-readonly',
          '-json',
          join(profile, 'memo.sqlite'),
          'SELECT (SELECT COUNT(*) FROM source_events) AS eventCount,last_success_at AS lastSuccessAt FROM plugin_bindings WHERE uninstalled=0;',
        ],
        { encoding: 'utf8' },
      ),
    )
    expect(disk).toEqual([
      { eventCount: 1, lastSuccessAt: baseline.lastSuccessAt },
    ])
    await writeFile(file, first) // Prevent a later legitimate poll from collecting the second fixture after restart.
    app = await launch()
    page = await ready()
    const restored = await plugin(page)
    expect(restored.status).toBe('active')
    expect(restored.eventCount).toBe(1)
    expect(restored.lastSuccessAt).toBe(baseline.lastSuccessAt)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.locator('#preset-plugins > summary').click()
    const formatted = await page.evaluate(
      (value) => new Date(value).toLocaleString(),
      baseline.lastSuccessAt!,
    )
    await expect(
      page.getByRole('region', { name: '声明式插件管理' }),
    ).toContainText(`最近成功：${formatted}`)
  } finally {
    await app?.evaluate(({ app }) => app.quit()).catch(() => {})
    await app?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from '@playwright/test'
import { existsSync } from 'node:fs'
import {
  mkdtemp,
  realpath,
  rm,
  cp,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
const sdk = resolve('.pet-sdk'),
  haru = join(sdk, 'CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
async function pick(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, path) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: [path] }),
    })
  }, path)
}
test('Haru plays one-shot motions and expressions, serializes plain-text bubbles and clears them on hide', async ({}, testInfo) => {
  test.skip(
    !existsSync(join(sdk, 'runtime/framework.js')) ||
      !existsSync(join(haru, 'Haru.model3.json')),
    'Local licensed runtime and Haru required; test never downloads assets',
  )
  test.setTimeout(150000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-presentation-')),
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
    await pick(app, haru)
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
    await pick(app, join(sdk, 'runtime'))
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
    let pet = app.windows().find((p) => p.url().startsWith('memo-pet://app/'))!
    const state = await main.evaluate(() => window.memo.pet.state())
    if (!state.ok || !state.data.catalog) throw Error('CATALOG_MISSING')
    const motion =
      state.data.catalog.motions.find((m) => m.label.startsWith('TapBody')) ??
      state.data.catalog.motions[0]!
    const expression = state.data.catalog.expressions[0]!
    expect(expression).toBeTruthy()
    expect(motion).toBeTruthy()
    await main.getByRole('button', { name: '设置', exact: true }).click()
    await expect(main.getByLabel('表情与动作', { exact: true })).toBeVisible()
    await main.getByLabel('表情与动作', { exact: true }).selectOption(motion.id)
    await main.getByRole('button', { name: '播放动作', exact: true }).click()
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.currentAction.id), {
        timeout: 15000,
      })
      .toBe(motion.id)
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.currentAction.kind), {
        timeout: 45000,
      })
      .toBe('idle')
    await main
      .getByLabel('表情与动作', { exact: true })
      .selectOption(expression.id)
    await main.getByRole('button', { name: '播放动作', exact: true }).click()
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.currentAction.kind))
      .toBe('expression')
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.currentAction.kind), {
        timeout: 10000,
      })
      .toBe('idle')
    // Includes markup-looking text: the bubble must contain text, never executable DOM.
    const focused = await app.evaluate(({ BrowserWindow, app }) => {
      const main = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL() === 'memo://app/index.html',
      )!
      app.focus({ steal: true })
      main.focus()
      return main.id
    })
    // Establish actual native focus before testing that a bubble preserves it.
    // BrowserWindow.focus() alone need not activate a background macOS app.
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id,
        ),
      )
      .toBe(focused)
    const hostile = '<img src=x onerror=window.__bubbleInjected=true> 普通文字'
    const speechInput = main.getByLabel('气泡文字', { exact: true })
    await speechInput.fill('')
    await expect(speechInput).toHaveValue('')
    await speechInput.fill(hostile)
    await expect(speechInput).toHaveValue(hostile)
    await main.getByRole('button', { name: '显示气泡', exact: true }).click()
    expect(
      (await main.evaluate(() => window.memo.pet.speak({ text: '第二条气泡' })))
        .ok,
    ).toBe(true)
    const bubble = pet.locator('#pet-bubble')
    await expect(bubble).toBeVisible()
    await expect(pet.locator('#pet-bubble-text')).toHaveText(hostile)
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id,
      ),
    ).toBe(focused)
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.currentAction.kind))
      .toBe('expression')
    expect(await bubble.locator('img,script').count()).toBe(0)
    expect(
      await pet.evaluate(
        () =>
          (window as unknown as { __bubbleInjected?: boolean })
            .__bubbleInjected,
      ),
    ).toBeUndefined()
    await pet.getByRole('button', { name: '关闭气泡' }).click()
    await expect(pet.locator('#pet-bubble-text')).toHaveText('第二条气泡')
    // At minimum pet size, content stays within the actual native window and wraps.
    expect(
      (await main.evaluate(() => window.memo.pet.configure({ scale: 0.5 }))).ok,
    ).toBe(true)
    await pet.getByRole('button', { name: '关闭气泡' }).click()
    const long = '很长的中文内容与longwordwithoutspaces'.repeat(5)
    expect(
      (await main.evaluate((text) => window.memo.pet.speak({ text }), long)).ok,
    ).toBe(true)
    await expect(pet.locator('#pet-bubble-text')).toHaveText(long)
    const geometry = await bubble.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const text = document.getElementById('pet-bubble-text')!
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
        font: parseFloat(getComputedStyle(text).fontSize),
        scroll: text.scrollHeight,
        client: text.clientHeight,
      }
    })
    expect(geometry.x).toBeGreaterThanOrEqual(0)
    expect(geometry.y).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.width)
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
    expect(geometry.font).toBeGreaterThanOrEqual(14)
    expect(geometry.scroll).toBeGreaterThan(geometry.client)
    await pet.screenshot({
      path: testInfo.outputPath('bubble-minimum-size.png'),
    })
    await expect(bubble).toBeHidden({ timeout: 15000 })
    await main.evaluate(() =>
      window.memo.pet.speak({ text: '隐藏后不能重新出现' }),
    )
    await main.evaluate(() => window.memo.pet.speak({ text: '排队内容也清除' }))
    expect((await main.evaluate(() => window.memo.pet.hide())).ok).toBe(true)
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
    pet = app.windows().find((p) => p.url().startsWith('memo-pet://app/'))!
    await expect(pet.locator('#pet-bubble')).toBeHidden()
    const final = await main.evaluate(() => window.memo.pet.state())
    expect(final.ok && final.data.presentation).toBeNull()
    const optional = join(root, 'no-optional-actions')
    await cp(haru, optional, { recursive: true })
    const manifestPath = join(optional, 'Haru.model3.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.FileReferences.Motions
    delete manifest.FileReferences.Expressions
    await writeFile(manifestPath, JSON.stringify(manifest))
    await pick(app, optional)
    const choice = await main.evaluate(() => window.memo.pet.openImportDialog())
    if (!choice.ok || !('sessionId' in choice.data))
      throw Error(`OPTIONAL_CHOOSE_FAILED: ${JSON.stringify(choice)}`)
    const copy = await main.evaluate(
      (id) => window.memo.pet.importChosen(id, 'Haru.model3.json'),
      choice.data.sessionId,
    )
    if (!copy.ok || copy.data.status === 'invalid')
      throw Error('OPTIONAL_IMPORT_FAILED')
    expect(
      (
        await main.evaluate(
          (id) => window.memo.pet.select(id),
          copy.data.model.id,
        )
      ).ok,
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
    pet = app.windows().find((p) => p.url().startsWith('memo-pet://app/'))!
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.mode))
      .toBe('live2d-idle')
    expect(
      (await main.evaluate(() => window.memo.pet.play('motion:0:0'))).ok,
    ).toBe(false)
    await expect
      .poll(() => pet.evaluate(() => window.__petRender?.frames ?? 0))
      .toBeGreaterThan(3)
    expect(
      (
        await main.evaluate(() =>
          window.memo.pet.speak({ text: '没有可选动作也能说话' }),
        )
      ).ok,
    ).toBe(true)
    await expect(pet.locator('#pet-bubble-text')).toHaveText(
      '没有可选动作也能说话',
    )
  } finally {
    if (app) {
      await app.evaluate(({ app }) => app.quit()).catch(() => {})
      await app.close().catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
})

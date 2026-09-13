import { test, expect, _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const requireDesktop = createRequire(resolve('apps/desktop/package.json'))
const sdk = resolve('.pet-sdk'),
  haru = join(sdk, 'CubismSdkForWeb-5-r.5/Samples/Resources/Haru')
for (const scenario of ['settings', 'manual', 'automatic'])
  test(
    scenario === 'automatic'
      ? 'automatic schedule emits a grounded reference without stealing focus'
      : scenario === 'manual'
        ? 'real contextual pet reference prompts navigation and preserves task draft'
        : 'context settings remain off and model receives only anonymous refs and status',
    async () => {
      const render = scenario !== 'settings'
      test.skip(
        render &&
          (!existsSync(join(haru, 'Haru.model3.json')) ||
            !existsSync(join(sdk, 'runtime/framework.js'))),
        'Licensed local SDK unavailable; no download',
      )
      test.setTimeout(90000)
      const root = await realpath(
          await mkdtemp(join(tmpdir(), 'bugu-context-ui-')),
        ),
        seed = join(root, 'seed.cjs'),
        fixture = join(root, 'http.cjs')
      await build({
        entryPoints: ['tests/fixtures/pet-context-seed.ts'],
        outfile: seed,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['better-sqlite3'],
      })
      await build({
        entryPoints: ['tests/fixtures/pet-context-http.ts'],
        outfile: fixture,
        bundle: true,
        platform: 'node',
        format: 'cjs',
      })
      execFileSync(requireDesktop('electron'), [seed, root], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_PATH: resolve('apps/desktop/node_modules'),
        },
        timeout: 30000,
      })
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          (x): x is [string, string] => x[1] !== undefined,
        ),
      )
      env.MEMO_TEST_USER_DATA = join(root, 'profile')
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_RENDERER_URL
      const bootstrap = join(root, 'bootstrap.cjs')
      await writeFile(
        bootstrap,
        `require(${JSON.stringify(fixture)}).install();require(${JSON.stringify(resolve('apps/desktop/out/main/index.js'))})`,
      )
      const app = await electron.launch({
        executablePath: requireDesktop('electron'),
        args: [bootstrap],
        env,
      })
      try {
        const page = await app.firstWindow()
        await expect(
          page.getByRole('heading', { name: '跟进', exact: true }),
        ).toBeVisible()
        const stats = () =>
          app.evaluate(
            (_, fixture) =>
              process
                .getBuiltinModule('module')
                .createRequire(fixture)(fixture)
                .stats() as string[],
            fixture,
          )
        await page.getByRole('button', { name: '设置', exact: true }).click()
        await page.getByText('项目与话语设置', { exact: true }).click()
        const panel = page.getByRole('region', { name: '基于事项的话语' })
        await expect(
          panel.getByRole('switch', {
            name: '允许基于事项生成话语',
            exact: true,
          }),
        ).not.toBeChecked()
        expect(await stats()).toHaveLength(0)
        await panel
          .getByRole('switch', { name: '允许基于事项生成话语', exact: true })
          .check()
        await panel
          .getByRole('checkbox', { name: '桌宠上下文验收', exact: true })
          .check()
        await panel
          .getByRole('checkbox', { name: '使用本地模型选择话术', exact: true })
          .check()
        await panel.getByLabel('本地模型名称').fill('fictional-local-model')
        await panel.getByRole('button', { name: '保存事项话语设置' }).click()
        await expect(
          panel.getByText('设置已保存，尚未生成话语。'),
        ).toBeVisible()
        expect(await stats()).toHaveLength(0)
        await panel.getByRole('button', { name: '生成一条预览' }).click()
        await expect(panel.locator('blockquote')).toContainText('桌宠引用事项')
        const sent = await stats()
        expect(sent).toHaveLength(1)
        expect(sent[0]).not.toContain('桌宠引用事项')
        expect(sent[0]).not.toContain('PRIVATE_SYNTHETIC_BODY')
        expect(sent[0]).not.toContain('pet-project')
        if (!render) {
          await panel.screenshot({
            path: 'test-results/pet-context-settings.png',
          })
          await page.setViewportSize({ width: 880, height: 820 })
          await panel.screenshot({
            path: 'test-results/pet-context-settings-narrow.png',
          })
          await page.setViewportSize({ width: 1440, height: 960 })
          await app.evaluate(
            (_, fixture) =>
              process
                .getBuiltinModule('module')
                .createRequire(fixture)(fixture)
                .setMode('invalid'),
            fixture,
          )
          await page.waitForTimeout(10100)
          await panel.getByRole('button', { name: '生成一条预览' }).click()
          await expect(
            panel.getByText('未生成事项话语，已回退本地预设。'),
          ).toBeVisible()
          await expect(panel.locator('blockquote')).not.toContainText(
            '桌宠引用事项',
          )
          await app.evaluate(
            (_, fixture) =>
              process
                .getBuiltinModule('module')
                .createRequire(fixture)(fixture)
                .setMode('wait'),
            fixture,
          )
          await page.waitForTimeout(10100)
          await panel.getByRole('button', { name: '生成一条预览' }).click()
          await expect.poll(async () => (await stats()).length).toBe(3)
          await panel.getByRole('button', { name: '取消生成' }).click()
          await expect(
            panel.getByRole('button', { name: '生成一条预览' }),
          ).toBeEnabled()
          return
        }
        const pick = async (path: string) =>
          app.evaluate(
            ({ dialog }, path) =>
              Object.defineProperty(dialog, 'showOpenDialog', {
                configurable: true,
                value: async () => ({ canceled: false, filePaths: [path] }),
              }),
            path,
          )
        await pick(haru)
        const chosen = await page.evaluate(() =>
          window.memo.pet.openImportDialog(),
        )
        if (!chosen.ok || !('sessionId' in chosen.data))
          throw Error('NO_SESSION')
        const imported = await page.evaluate(
          (sessionId) =>
            window.memo.pet.importChosen(sessionId, 'Haru.model3.json'),
          chosen.data.sessionId,
        )
        if (!imported.ok || imported.data.status === 'invalid')
          throw Error('NO_MODEL')
        await page.evaluate(
          (id) => window.memo.pet.select(id),
          imported.data.model.id,
        )
        await pick(join(sdk, 'runtime'))
        expect(
          (await page.evaluate(() => window.memo.pet.installRuntime())).ok,
        ).toBe(true)
        expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(
          true,
        )
        await expect
          .poll(async () => {
            const s = await page.evaluate(() => window.memo.pet.state())
            return s.ok ? s.data.renderStatus : null
          })
          .toBe('ready')
        if (scenario === 'automatic') {
          const configured = await page.evaluate(async () => {
            const state = await window.memo.pet.contextState()
            if (!state.ok) throw Error('STATE_FAILED')
            const { version, ...config } = state.data.config
            return window.memo.pet.configureContext({
              expectedVersion: version,
              config: { ...config, useModel: false, model: '' },
            })
          })
          expect(configured.ok).toBe(true)
          await app.evaluate(() => {
            const originalTimeout = globalThis.setTimeout
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
              if (delay !== 15000)
                return originalTimeout(callback, delay, ...args)
              return originalTimeout(() => {
                if (steps < 46) {
                  fakeNow += 60000
                  steps++
                }
                callback(...args)
              }, 10)
            }) as typeof setTimeout
          })
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()
              .find((w) => !w.webContents.getURL().startsWith('memo-pet:'))
              ?.focus(),
          )
          expect(
            (
              await page.evaluate(() =>
                window.memo.pet.configureSpeech({
                  enabled: true,
                  frequency: 'normal',
                  quietStart: 1320,
                  quietEnd: 540,
                  pausedUntil: null,
                }),
              )
            ).ok,
          ).toBe(true)
          const automaticPet = app.windows().find((p) => p !== page)!
          await expect(automaticPet.locator('#pet-bubble-text')).toContainText(
            '桌宠引用事项',
            { timeout: 30000 },
          )
          expect(
            await app.evaluate(
              ({ BrowserWindow }) =>
                BrowserWindow.getFocusedWindow()
                  ?.webContents.getURL()
                  .startsWith('memo-pet:') ?? false,
            ),
          ).toBe(false)
          expect(await stats()).toHaveLength(1)
        } else {
          // Selecting the model invalidates older context previews. Generate anew.
          await panel
            .getByRole('checkbox', {
              name: '使用本地模型选择话术',
              exact: true,
            })
            .uncheck()
          await panel.getByRole('button', { name: '保存事项话语设置' }).click()
          await expect(
            panel.getByText('设置已保存，尚未生成话语。'),
          ).toBeVisible()
          await panel.getByRole('button', { name: '生成一条预览' }).click()
          await expect(panel.locator('blockquote')).toContainText(
            '桌宠引用事项',
          )
          await panel.getByRole('button', { name: '显示到桌宠' }).click()
          await expect(panel.getByText('话语已提交桌宠显示。')).toBeVisible()
        }
        await page.getByRole('button', { name: /^跟进/ }).click()
        await page
          .getByRole('button', { name: '我的工作区', exact: true })
          .click()
        await page.getByText('保留草稿的另一事项', { exact: true }).click()
        await page.getByText('编辑事项与完成条件', { exact: true }).click()
        await page.getByLabel('编辑事项标题').fill('必须保留的未保存标题')
        const pet = app.windows().find((p) => p !== page)!
        await pet.getByRole('button', { name: '查看相关事项' }).click()
        await expect(
          page.getByRole('button', { name: '打开桌宠提到的事项' }),
        ).toBeVisible()
        await expect(page.getByLabel('编辑事项标题')).toHaveValue(
          '必须保留的未保存标题',
        )
        await page.getByRole('button', { name: '打开桌宠提到的事项' }).click()
        await expect(
          page
            .getByRole('region', { name: '事项详情' })
            .getByRole('heading', { name: '桌宠引用事项', exact: true }),
        ).toBeVisible()
        await page.getByRole('button', { name: '关闭详情' }).click()
        await page.getByText('保留草稿的另一事项', { exact: true }).click()
        await expect(page.getByLabel('编辑事项标题')).toHaveValue(
          '必须保留的未保存标题',
        )
        if (scenario === 'manual') {
          await page.getByRole('button', { name: '关闭详情' }).click()
          const changed = await page.evaluate(async () => {
            const r = await window.memo.workspace.detail(
              'pet-project',
              'draft-task',
            )
            if (!r.ok) throw Error('MISSING_TASK')
            const t = r.data.task
            return window.memo.workspace.updateTask({
              projectId: t.projectId!,
              id: t.id,
              expectedVersion: t.version,
              expectedCriteriaVersion: t.criteriaVersion,
              expectedManualVersion: t.manualVersion,
              patch: {
                title: '别处保存的新标题',
                dueAt: '2027-01-01T00:00:00Z',
              },
            })
          })
          expect(changed.ok).toBe(true)
          await page.getByRole('button', { name: '刷新', exact: true }).click()
          await page.getByText('别处保存的新标题', { exact: true }).click()
          await page.getByText('编辑事项与完成条件', { exact: true }).click()
          await expect(page.getByLabel('编辑事项标题')).toHaveValue(
            '必须保留的未保存标题',
          )
          await expect(
            page.getByRole('alert', { name: '草稿版本冲突' }),
          ).toContainText('别处保存的新标题')
          await expect(
            page.getByRole('button', { name: '保存标题', exact: true }),
          ).toBeDisabled()
          await expect(
            page.getByRole('button', { name: '保存截止时间', exact: true }),
          ).toBeDisabled()
          await page
            .getByRole('button', { name: '已核对，继续使用草稿' })
            .click()
          await expect(
            page.getByRole('button', { name: '保存标题', exact: true }),
          ).toBeEnabled()
          await page
            .getByRole('button', { name: '保存标题', exact: true })
            .click()
          await expect(
            page
              .getByRole('region', { name: '事项详情' })
              .getByRole('heading', {
                name: '必须保留的未保存标题',
                exact: true,
              }),
          ).toBeVisible()
        }
      } finally {
        await app.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

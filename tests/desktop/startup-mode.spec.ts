import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
for (const mode of ['demo', 'real'] as const) {
  test(`explicit ${mode} startup opens the requested workspace after reload`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bugu-mode-'))
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    env.MEMO_TEST_USER_DATA = root
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    const app = await electron.launch({
      executablePath: require('electron'),
      args: [resolve('apps/desktop'), `--mode=${mode}`],
      env,
    })
    try {
      const page = await app.firstWindow()
      for (let i = 0; i < 2; i++) {
        await expect(
          page.getByRole('heading', { name: '跟进', exact: true }),
        ).toBeVisible()
        expect(await page.evaluate(() => window.memo.startupMode)).toBe(mode)
        await expect(page.getByLabel('数据模式')).toHaveCount(0)
        if (mode === 'real') {
          await expect(
            page.getByText('示例数据 · 所有操作仅用于设计预览'),
          ).toHaveCount(0)
          await expect(
            page.getByRole('button', { name: '新建第一件事', exact: true }),
          ).toBeVisible()
        } else {
          await expect(
            page.getByText('示例数据 · 所有操作仅用于设计预览'),
          ).toBeVisible()
        }
        if (i === 0) await page.reload()
      }
    } finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}

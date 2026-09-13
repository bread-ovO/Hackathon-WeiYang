import { test, expect, _electron as electron } from '@playwright/test'
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  rm,
  readdir,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
test('credentials stay in host encrypted storage and survive restart without plaintext in renderer', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-vault-desktop-')),
  )
  const data = join(root, 'data'),
    token = 'fictional-Q01-token-2026'
  const file = join(root, 'token.txt')
  await writeFile(file, token + '\n')
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = data
  delete env.ELECTRON_RUN_AS_NODE
  let output = ''
  const launch = async () => {
    const instance = await electron.launch({
      executablePath: require('electron'),
      args: [resolve('apps/desktop/out/main/index.js')],
      env,
    })
    instance.process().stdout?.on('data', (chunk) => {
      output += chunk.toString()
    })
    instance.process().stderr?.on('data', (chunk) => {
      output += chunk.toString()
    })
    return instance
  }
  const assertNoPlaintext = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await assertNoPlaintext(path)
      else if (entry.isFile())
        expect((await readFile(path)).includes(Buffer.from(token))).toBe(false)
    }
  }
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-credentials > summary').click()
    const status = await page.evaluate(() => window.memo.credentials.list())
    expect(status.ok).toBe(true)
    console.log(
      'Credential encryption available:',
      status.ok && status.data.encryptionAvailable,
    )
    if (!status.ok) throw new Error('VAULT_UNAVAILABLE')
    await page.getByLabel('凭据名称').fill('测试令牌')
    await page.getByLabel('凭据授权域名').fill('api.example.com')
    if (!status.data.encryptionAvailable) {
      await expect(
        page.getByRole('button', { name: '导入凭据文件' }),
      ).toBeDisabled()
      expect(
        await page.evaluate(() =>
          window.memo.credentials.importFile({
            label: '测试令牌',
            domain: 'api.example.com',
            purpose: 'source',
          }),
        ),
      ).toEqual({ ok: false, error: 'VAULT_UNAVAILABLE' })
      return
    }
    await app.evaluate(({ dialog }, file) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: false, filePaths: [file] }),
      })
    }, file)
    await page.getByRole('button', { name: '导入凭据文件' }).click()
    await expect(page.getByText('凭据已加密保存，尚未绑定连接。')).toBeVisible()
    const registryPath = join(data, 'credentials', 'credentials.json')
    const registry = await readFile(registryPath, 'utf8')
    expect(registry).not.toContain(token)
    const imported = await page.evaluate(() => window.memo.credentials.list())
    if (!imported.ok) throw new Error('LIST_FAILED')
    expect(imported.data.credentials).toHaveLength(1)
    expect(Object.keys(imported.data.credentials[0]!).sort()).toEqual(
      ['id', 'label', 'domain', 'purpose', 'createdAt'].sort(),
    )
    expect(JSON.stringify(imported)).not.toContain(token)
    expect(await page.content()).not.toContain(token)
    expect(await readFile(file, 'utf8')).toBe(token + '\n')
    // Native cryptography must really decrypt, not merely encode the token in a different format.
    const cipher = JSON.parse(registry).records[0].ciphertext as string
    expect(
      await app.evaluate(
        ({ safeStorage }, cipher) =>
          JSON.parse(safeStorage.decryptString(Buffer.from(cipher, 'base64')))
            .secret === 'fictional-Q01-token-2026',
        cipher,
      ),
    ).toBe(true)
    await app.evaluate(({ dialog }) => {
      Object.defineProperty(dialog, 'showOpenDialog', {
        configurable: true,
        value: async () => ({ canceled: true, filePaths: [] }),
      })
    })
    await page.getByRole('button', { name: '导入凭据文件' }).click()
    await expect(page.getByText('已取消，凭据未改变。')).toBeVisible()
    expect(await readFile(registryPath, 'utf8')).toBe(registry)
    await page.locator('.credential-panel').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/credentials-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(860, 620),
    )
    await page.screenshot({ path: 'test-results/credentials-narrow.png' })
    expect(
      await page
        .locator('.credential-panel')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true)
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await assertNoPlaintext(data)
    expect(output).not.toContain(token)
    app = await launch()
    page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-credentials > summary').click()
    await expect(page.getByText('测试令牌', { exact: true })).toBeVisible()
    expect(
      await app.evaluate(
        ({ safeStorage }, cipher) =>
          JSON.parse(safeStorage.decryptString(Buffer.from(cipher, 'base64')))
            .secret === 'fictional-Q01-token-2026',
        cipher,
      ),
    ).toBe(true)
    await page.getByRole('button', { name: '移除凭据 测试令牌' }).click()
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.getByText('测试令牌', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '移除凭据 测试令牌' }).click()
    await page.getByRole('button', { name: '确认移除' }).click()
    await expect(
      page.getByText('本机凭据已移除。服务端 Token 未被撤销。'),
    ).toBeVisible()
    expect(JSON.parse(await readFile(registryPath, 'utf8')).records).toEqual([])
  } finally {
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

/** Runs only on an ephemeral GitHub Windows runner, against an installed package. */
import { _electron as electron, expect } from '@playwright/test'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true')
  throw Error('EPHEMERAL_WINDOWS_RUNNER_REQUIRED')
const executablePath = resolve(process.env.BUGU_INSTALLED_EXE || '')
if (!executablePath.endsWith('BUGU 不咕.exe')) throw Error('INSTALLED_EXE_REQUIRED')
const output = resolve('test-results/windows-installed')
await mkdir(output, { recursive: true })
const report = { executablePath, checks: {}, errors: [], console: [] }
let app
let failed = false
try {
  report.plainLaunch = JSON.parse((await readFile(join(output, 'plain-launch.json'), 'utf8')).replace(/^\uFEFF/, ''))
  expect(report.plainLaunch.installerExit).toBe(0)
  expect(report.plainLaunch.exited).toBe(false)
  report.checks.ordinaryLaunch = true
  app = await electron.launch({ executablePath, args: [], timeout: 45000 })
  app.process().stderr?.on('data', c => report.console.push(String(c).slice(0, 8000)))
  app.on('window', page => {
    page.on('pageerror', error => report.errors.push(String(error)))
    page.on('console', msg => { if (msg.type() === 'error') report.console.push(msg.text()) })
  })
  report.runtime = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged, version: app.getVersion(), platform: process.platform,
    arch: process.arch, versions: process.versions, userData: app.getPath('userData'),
  }))
  expect(report.runtime.packaged).toBe(true)
  expect(report.runtime.platform).toBe('win32')
  expect(report.runtime.version).toBe(process.env.BUGU_EXPECTED_VERSION)
  const page = await app.firstWindow({ timeout: 30000 })
  await page.waitForURL('memo://app/index.html', { timeout: 30000 })
  await expect(page.getByRole('heading', { name: '跟进', exact: true })).toBeVisible({ timeout: 30000 })
  report.checks.mainWindow = true
  await expect.poll(() => page.evaluate(async () => (await window.memo.health()).ok), { timeout: 20000 }).toBe(true)
  report.health = await page.evaluate(() => window.memo.health())
  expect(report.health.data.schemaVersion).toBe(25)
  const initial = await page.evaluate(() => window.memo.workspace.list())
  report.initialWorkspace = initial
  expect(initial.ok).toBe(true)
  expect(initial.data.projects).toHaveLength(0)
  report.checks.emptyWorkspaceAndSqlite = true
  expect(await page.evaluate(() => typeof globalThis.require)).toBe('undefined')
  report.model = await page.evaluate(() => window.memo.modelProvider.status())
  expect(report.model.ok && !report.model.data.config.enabled).toBe(true)
  await page.screenshot({ path: join(output, 'main.png') })
  const created = await page.evaluate(() => window.memo.workspace.createProject('Windows 安装验收'))
  expect(created.ok).toBe(true)
  const projectId = created.data.projects.find(p => p.name === 'Windows 安装验收').id
  report.projectId = projectId
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await page.screenshot({ path: join(output, 'connections.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.screenshot({ path: join(output, 'settings.png') })
  report.pet = await page.evaluate(() => window.memo.pet.state())
  expect(report.pet.ok).toBe(true)
  expect(report.pet.data.models).toHaveLength(1)
  expect(JSON.stringify(report.pet.data.models)).not.toMatch(/haru/i)
  expect((await page.evaluate(() => window.memo.pet.show())).ok).toBe(true)
  await expect.poll(async () => {
    const r = await page.evaluate(() => window.memo.pet.state())
    return r.ok && r.data.renderStatus
  }, { timeout: 20000 }).toBe('ready')
  const petPage = app.windows().find(p => p.url().includes('pet.html'))
  expect(petPage).toBeDefined()
  await petPage.screenshot({ path: join(output, 'pet.png') })
  report.checks.defaultPetWindow = true
  await app.close()
  app = await electron.launch({ executablePath, args: [], timeout: 45000 })
  const reopened = await app.firstWindow()
  await expect(reopened.getByRole('heading', { name: '跟进', exact: true })).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => {
    const r = await reopened.evaluate(() => window.memo.workspace.list())
    return r.ok && r.data.projects.some(p => p.id === projectId)
  }, { timeout: 15000 }).toBe(true)
  report.checks.relaunchPersistsProject = true
} catch (e) {
  failed = true
  report.errors.push(e.stack || String(e))
} finally {
  if (app) {
    report.windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({title:w.getTitle(),url:w.webContents.getURL(),visible:w.isVisible()}))).catch(String)
    for (const [i, page] of app.windows().entries())
      await page.screenshot({path:join(output, `final-window-${i}.png`), timeout:5000}).catch(() => {})
    await app.close().catch(() => {})
  }
  report.passed = !failed
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
}
if (failed) {
  console.error(report.errors.join('\n'))
  process.exitCode = 1
}

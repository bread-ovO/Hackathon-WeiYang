import { _electron as electron } from '@playwright/test'
import { mkdtempSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))
const shots = resolve('../shots')
mkdirSync(shots, { recursive: true })
const root = realpathSync(mkdtempSync(join(tmpdir(), 'bugu-real-')))
const env = { ...process.env, MEMO_TEST_USER_DATA: root }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: require('electron'),
  args: [resolve('apps/desktop/out/main/index.js')],
  env,
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(3000)
async function shot(name) {
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(shots, name + '.png') })
  console.log('shot', name)
}
// 切到真实工作区
await page.getByRole('button', { name: '我的工作区', exact: true }).click()
await page.waitForTimeout(500)
await page.waitForFunction(async () => (await window.memo.health()).ok, null, { timeout: 15000 })

for (const width of [1140, 880]) {
  await app.evaluate(
    ({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setSize(w, 800),
    width,
  )
  await page.waitForTimeout(400)
  await shot(`real-空状态-${width}`)
  // 创建项目
  await page.getByLabel('新项目名称').fill('工作台改版')
  await page.getByRole('button', { name: '创建项目', exact: true }).click()
  await page.waitForTimeout(600)
  // 创建事项
  await page.getByLabel('所属项目').selectOption({ label: '工作台改版' })
  await page.getByLabel('真实事项标题').fill('核对接口说明并反馈给同事')
  await page.getByRole('button', { name: '添加事项', exact: true }).click()
  await page.waitForTimeout(800)
  await shot(`real-有事项-${width}`)
  // 打开事项编辑器（窄宽前先关掉已打开的详情）
  const closer = page.getByRole('button', { name: '关闭详情', exact: true })
  if (await closer.count()) await closer.first().click().catch(() => {})
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: /核对接口说明并反馈给同事/ }).first().click()
  await page.waitForTimeout(600)
  await shot(`real-编辑器-${width}`)
  // 展开编辑器内所有 disclosure 看完整密度
  const summaries = page.locator('.real-editor summary, main summary:visible')
  const n = await summaries.count()
  for (let i = 0; i < n; i++) await summaries.nth(i).click().catch(() => {})
  await page.waitForTimeout(400)
  await shot(`real-编辑器-全展开-${width}`)
  await page.keyboard.press('Escape')
}
await app.close()
console.log('done')

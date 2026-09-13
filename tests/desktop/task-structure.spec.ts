import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(resolve('apps/desktop/package.json'))

// H04：事项拆分的真实工作区端到端（合并 H03 由 #124 的 TaskMerge 覆盖）。
// 拆分后条件与证据归属明确，双方都保留拆分记录。
test('workspace tasks split selected criteria into a new task', async ({}, testInfo) => {
  test.setTimeout(120000)
  const root = await mkdtemp(join(tmpdir(), 'bugu-task-structure-e2e-'))
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = root
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [resolve('apps/desktop/out/main/index.js')],
    env,
  })
  try {
    const page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await page.getByRole('button', { name: '我的工作区', exact: true }).click()
    await page.getByRole('button', {name:'新建事项',exact:true}).click()
    await page.getByLabel('新项目名称').fill('拆分项目')
    await page.getByRole('button', { name: '创建项目', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('项目已创建')
    await page.getByLabel('真实事项标题').fill('混杂事项')
    await page
      .getByRole('button', { name: '添加事项', exact: true })
      .click()
    await expect(
      page.getByRole('button', { name: /混杂事项/ }),
    ).toBeVisible()
    await page.getByRole('button', { name: /混杂事项/ }).click()
    await expect(
      page.getByRole('region', { name: '事项详情' }),
    ).toBeVisible()
    await page.getByText('编辑事项与完成条件',{exact:true}).click()
    await page.getByRole('button', { name: '添加条件', exact: true }).click()
    await page.getByRole('button', { name: '添加条件', exact: true }).click()
    const criterionInputs = page.getByLabel(/^条件 \d+$/)
    await criterionInputs.nth(0).fill('反馈链接')
    await criterionInputs.nth(1).fill('补充测试')
    await page.getByRole('button', { name: '保存条件', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('条件新版本已保存')
    await page.getByText('拆分事项').click()
    await page
      .getByRole('checkbox', {
        name: '补充测试',
      })
      .check()
    await page.getByLabel('新事项标题').fill('拆出的补充测试')
    await page.getByRole('button', { name: '拆分出所选条件' }).click()
    await expect(page.getByRole('status')).toContainText('已拆分')
    // 条件展示顺序按 criterion_id（随机 UUID），断言按集合而非顺序。
    const criterionValues = () =>
      page
        .getByLabel(/^条件 \d+$/)
        .evaluateAll((els) =>
          els.map((e) => (e as HTMLInputElement).value).sort(),
        )
    await expect.poll(criterionValues).toEqual(['反馈链接'])
    // 拆出的新事项出现在列表中，且包含被移出的条件。
    await expect(page.locator('.task-row')).toHaveCount(2)
    await page.getByRole('button', { name: /拆出的补充测试/ }).click()
    await expect.poll(criterionValues).toEqual(['补充测试'])
    await page.screenshot({
      animations: 'disabled',
      path: testInfo.outputPath('task-structure.png'),
    })
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})

import { watch } from 'node:fs'
import { test, expect, _electron as electron } from '@playwright/test'
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  open,
  readdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
const require = createRequire(resolve('apps/desktop/package.json'))
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(type, 4)
    data.copy(result, 8)
    let crc = 0xffffffff
    for (const byte of result.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(5))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Synthetic header-only moc: proves controlled asset management, not Cubism rendering.
test('pet model management imports chosen entries, preserves selection, removes copies and survives restart', async () => {
  test.setTimeout(60000)
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-pet-management-')),
  )
  const source = join(root, 'source')
  await mkdir(source)
  for (const entry of ['one.model3.json', 'two.model3.json'])
    await writeFile(
      join(source, entry),
      JSON.stringify({
        Version: 3,
        FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] },
      }),
    )
  await writeFile(join(source, 'pet.moc3'), 'MOC3\x01\0\0\0')
  await writeFile(join(source, 'pet.png'), png())
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () =>
    electron.launch({
      executablePath: require('electron'),
      args: [resolve('apps/desktop/out/main/index.js')],
      env,
    })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.pet.state()).ok))
      .toBe(true)
    const choose = async (directory: string | null) =>
      app.evaluate(({ dialog }, directory) => {
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({
            canceled: directory === null,
            filePaths: directory ? [directory] : [],
          }),
        })
      }, directory)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-pet > summary').click()
    const panel = page.getByRole('region', { name: '桌宠模型管理' })
    await choose(source)
    // Native choice, visible entry selection, confirmation and import all use the real bridge/worker.
    await panel
      .getByRole('button', { name: '选择模型目录', exact: true })
      .click()
    await page.getByLabel('模型入口').selectOption('one.model3.json')
    await panel.getByRole('button', { name: '导入模型', exact: true }).click()
    await expect(panel).toContainText('one.model3.json')
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.pet.state())
        return r.ok ? r.data.models.length : -1
      })
      .toBe(1)
    const first = await page.evaluate(() => window.memo.pet.state())
    if (!first.ok) throw Error('STATE_FAILED')
    const id = first.data.models[0]!.id
    expect(first.data.currentModelId).toBeNull()
    expect(JSON.stringify(first)).not.toContain(root)
    expect(JSON.stringify(first)).not.toContain('resources')
    expect(
      await page.evaluate(() =>
        window.memo.pet.importChosen(
          '00000000-0000-0000-0000-000000000000',
          'one.model3.json',
        ),
      ),
    ).toEqual({ ok: false, error: 'IMPORT_SESSION_INVALID' })
    // Select is explicit; duplicate import and picker cancellation preserve it.
    await panel.getByRole('button', { name: '设为当前', exact: true }).click()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.pet.state())
        return r.ok ? r.data.currentModelId : null
      })
      .toBe(id)
    const selection = await page.evaluate(() =>
      window.memo.pet.openImportDialog(),
    )
    if (!selection.ok || !('sessionId' in selection.data))
      throw Error('CHOOSE_FAILED')
    const duplicate = await page.evaluate(
      ({ sessionId }) =>
        window.memo.pet.importChosen(sessionId, 'one.model3.json'),
      selection.data,
    )
    expect(duplicate.ok && duplicate.data.status).toBe('duplicate')
    const stale = await page.evaluate(() => window.memo.pet.openImportDialog())
    if (!stale.ok || !('sessionId' in stale.data)) throw Error('CHOOSE_FAILED')
    await choose(null)
    expect(
      await page.evaluate(() => window.memo.pet.openImportDialog()),
    ).toEqual({ ok: true, data: { status: 'cancelled' } })
    expect(
      (
        await page.evaluate(
          ({ sessionId }) =>
            window.memo.pet.importChosen(sessionId, 'two.model3.json'),
          stale.data,
        )
      ).ok,
    ).toBe(false)
    const bad = join(root, 'bad')
    await mkdir(bad)
    await writeFile(
      join(bad, 'bad.model3.json'),
      JSON.stringify({
        Version: 3,
        FileReferences: { Moc: 'missing.moc3', Textures: ['missing.png'] },
      }),
    )
    await choose(bad)
    const invalidChoice = await page.evaluate(() =>
      window.memo.pet.openImportDialog(),
    )
    if (!invalidChoice.ok || !('sessionId' in invalidChoice.data))
      throw Error('CHOOSE_FAILED')
    const invalid = await page.evaluate(
      ({ sessionId }) =>
        window.memo.pet.importChosen(sessionId, 'bad.model3.json'),
      invalidChoice.data,
    )
    expect(invalid.ok && invalid.data.status).toBe('invalid')
    expect(JSON.stringify(invalid)).not.toContain(root)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.pet.state())
        return r.ok ? r.data.currentModelId : null
      })
      .toBe(id)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('#settings-pet > summary').click()
    const restarted = page.getByRole('region', { name: '桌宠模型管理' })
    await expect(restarted).toContainText('one.model3.json')
    await restarted.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/bugu-pet-management-wide.png' })
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(980, 720),
    )
    await restarted.scrollIntoViewIfNeeded()
    await page.screenshot({ path: '/tmp/bugu-pet-management-narrow.png' })
    await restarted.getByRole('button', { name: '移除', exact: true }).click()
    await restarted
      .getByRole('button', { name: '确认移除', exact: true })
      .click()
    await expect(restarted).toContainText('还没有模型')
    const removed = await page.evaluate(() => window.memo.pet.state())
    expect(removed.ok && removed.data.models.length).toBe(0)
    expect(removed.ok && removed.data.currentModelId).toBeNull()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.health()).ok))
      .toBe(true)
  } finally {
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('killed pet worker recovers staged copies without losing the current model', async () => {
  test.setTimeout(60000)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bugu-pet-kill-')))
  const source = join(root, 'source')
  await mkdir(source)
  const entry = 'pet.model3.json'
  await writeFile(
    join(source, entry),
    JSON.stringify({
      Version: 3,
      FileReferences: { Moc: 'pet.moc3', Textures: ['pet.png'] },
    }),
  )
  await writeFile(join(source, 'pet.moc3'), 'MOC3\x01\0\0\0')
  await writeFile(join(source, 'pet.png'), png())
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (x): x is [string, string] => x[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(root, 'profile')
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () =>
    electron.launch({
      executablePath: require('electron'),
      args: [resolve('apps/desktop/out/main/index.js')],
      env,
    })
  let app = await launch()
  let watcher: ReturnType<typeof watch> | undefined
  try {
    let page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(async () => (await window.memo.pet.state()).ok))
      .toBe(true)
    await app.evaluate(
      ({ dialog }, source) =>
        Object.defineProperty(dialog, 'showOpenDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePaths: [source] }),
        }),
      source,
    )
    const choose = await page.evaluate(() => window.memo.pet.openImportDialog())
    if (!choose.ok || !('sessionId' in choose.data))
      throw Error('CHOOSE_FAILED')
    const imported = await page.evaluate(
      ({ sessionId }) =>
        window.memo.pet.importChosen(sessionId, 'pet.model3.json'),
      choose.data,
    )
    if (!imported.ok || imported.data.status === 'invalid')
      throw Error('IMPORT_FAILED')
    const currentId = imported.data.model.id
    expect(
      (await page.evaluate((id) => window.memo.pet.select(id), currentId)).ok,
    ).toBe(true)
    // A larger synthetic moc gives the OS watcher time to observe actual staging.
    const file = await open(join(source, 'pet.moc3'), 'r+')
    await file.truncate(32 * 1024 * 1024)
    await file.close()
    const again = await page.evaluate(() => window.memo.pet.openImportDialog())
    if (!again.ok || !('sessionId' in again.data)) throw Error('CHOOSE_FAILED')
    const pid = await app.evaluate(
      ({ app }) =>
        app.getAppMetrics().find((m) => m.name === 'Pet Model Worker')?.pid,
    )
    if (!pid) throw Error('WORKER_NOT_FOUND')
    let killed = false
    const store = join(root, 'profile', 'pet-models')
    watcher = watch(store, (_event, name) => {
      if (!killed && name?.toString().startsWith('.staging-')) {
        killed = true
        process.kill(pid, 'SIGKILL')
      }
    })
    await page.evaluate(
      ({ sessionId }) =>
        window.memo.pet.importChosen(sessionId, 'pet.model3.json'),
      again.data,
    )
    expect(killed).toBe(true)
    watcher.close()
    watcher = undefined
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(
      page.getByRole('heading', { name: '跟进', exact: true }),
    ).toBeVisible()
    await expect
      .poll(async () => {
        const r = await page.evaluate(() => window.memo.pet.state())
        return r.ok ? r.data.currentModelId : null
      })
      .toBe(currentId)
    const recovered = await page.evaluate(() => window.memo.pet.state())
    if (!recovered.ok) throw Error('RECOVERY_FAILED')
    // A termination arriving after commit may leave a complete new model, never a partial selectable one.
    expect(recovered.data.models.some((m) => m.id === currentId)).toBe(true)
    expect(
      (await readdir(store)).filter((n) => n.startsWith('.staging-')),
    ).toEqual([])
    expect((await page.evaluate(() => window.memo.health())).ok).toBe(true)
  } finally {
    watcher?.close()
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { CoreReply } from '@memo/contracts'

const require = createRequire(resolve('apps/desktop/package.json'))
type ProbeWindow = Window & {
  securityProbe: { request(...args: unknown[]): Promise<CoreReply> }
  __sourceExecuted?: number
}
const payload =
  '<img src=x onerror=globalThis.__sourceExecuted=1><script>globalThis.__sourceExecuted=1</script>'

test('real IPC rejects foreign windows and malformed requests; source text stays inert', async () => {
  const data = await mkdtemp(join(tmpdir(), 'bugu-security-'))
  const root = resolve('apps/desktop/out/renderer')
  let fixtureReplaced = false
  let allowTestFrame = false
  // Serve the built renderer with a malicious fictional source body. No real source data is read.
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname
      const file = resolve(
        root,
        '.' + (pathname === '/' ? '/index.html' : pathname),
      )
      if (!file.startsWith(root + sep)) {
        response.writeHead(403).end()
        return
      }
      let text = await readFile(file, 'utf8')
      if (file.endsWith('.html') && allowTestFrame)
        text = text.replace("frame-src 'none'", "frame-src 'self'")
      if (file.endsWith('.js')) {
        const original =
          '刷新会话的逻辑已更新；相关测试通过。这是执行记录，不能替代反馈。'
        if (text.includes(original)) {
          text = text.replace(original, payload)
          fixtureReplaced = true
        }
      }
      response.setHeader(
        'Content-Type',
        file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      )
      response.end(text)
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('TEST_SERVER_MISSING')
  const url = `http://127.0.0.1:${address.port}/`
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined,
    ),
  )
  env.MEMO_TEST_USER_DATA = join(data, 'profile')
  env.ELECTRON_RENDERER_URL = url
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
    expect(await page.evaluate(() => Object.keys(window.memo))).toEqual([
      'health',
      'plugins',
      'credentials',
      'exports',
      'sources',
      'workspace',
    ])
    expect(
      await page.evaluate(() => Object.keys(window.memo.workspace)),
    ).toEqual([
      'list',
      'detail',
      'replaceCriteria',
      'createProject',
      'createTask',
      'updateTask',
    ])
    expect(await page.evaluate(() => Object.keys(window.memo.sources))).toEqual(
      ['list', 'chooseFile', 'sync', 'revoke'],
    )
    expect(await page.evaluate(() => Object.keys(window.memo.exports))).toEqual(
      ['save'],
    )
    expect(
      await page.evaluate(() => Object.keys(window.memo.credentials)),
    ).toEqual(['list', 'importFile', 'remove'])
    expect(await page.evaluate(() => Object.keys(window.memo.plugins))).toEqual(
      ['list', 'inspect', 'trial', 'activate', 'disable', 'uninstall', 'sync'],
    )
    // Privileged test harness only: inject a temporary probe, never ship raw IPC in production preload.
    const preload = join(data, 'probe.cjs')
    await writeFile(
      preload,
      "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('securityProbe',{request:(...args)=>ipcRenderer.invoke('memo:request',...args)});",
    )
    await app.evaluate(({ session }, filePath) => {
      session.defaultSession.registerPreloadScript({ type: 'frame', filePath })
    }, preload)
    await page.reload()
    await expect
      .poll(() =>
        page.evaluate(
          () => typeof (window as unknown as ProbeWindow).securityProbe,
        ),
      )
      .toBe('object')
    const update = {
      method: 'workspace.updateTask',
      projectId: 'project-1',
      id: 'task-1',
      expectedVersion: 1,
      expectedCriteriaVersion: 1,
      expectedManualVersion: 0,
      patch: { status: 'completed' },
    }
    for (const args of [
      [],
      [null],
      [{ method: 'readFile', path: '/private' }],
      [{ method: 'health', unexpected: true }],
      [{ method: 'x'.repeat(65537) }],
      [{ method: 'health' }, 'extra'],
      [{ method: 'pluginHost.list' }],
      [{ method: 'pluginHost.get', id: 'plugin-1' }],
      [
        {
          method: 'pluginHost.activate',
          input: {
            manifest: {},
            grant: { kind: 'local-jsonl', path: '/private' },
          },
        },
      ],
      [
        {
          method: 'pluginHost.receiveBatch',
          input: { id: 'plugin-1', events: [] },
        },
      ],
      [{ method: 'plugins.inspect', path: '/private/manifest.json' }],
      [
        {
          method: 'plugins.trial',
          inspectionId: 'i',
          projectId: 'p',
          path: '/private/events.jsonl',
        },
      ],
      [
        {
          method: 'plugins.trial',
          inspectionId: 'i',
          projectId: 'p',
          secret: 'forged-secret',
        },
      ],
      [
        {
          method: 'plugins.trial',
          inspectionId: 'i',
          projectId: 'p',
          token: 'forged-token',
        },
      ],
      [
        {
          method: 'plugins.activate',
          trialId: 't',
          projectId: 'other-project',
        },
      ],
      [{ method: 'plugins.activate', trialId: 't', manifest: {} }],
      [{ method: 'workspace.list', extra: true }],
      [{ method: 'workspace.list' }, 'extra'],
      [{ method: 'workspace.createTask', projectId: '', title: 'Task' }],
      [
        {
          method: 'workspace.createTask',
          projectId: 'x'.repeat(257),
          title: 'Task',
        },
      ],
      [{ method: 'workspace.createTask', projectId: null, title: 'Task' }],
      [{ ...update, actorId: 'other-user' }],
      [{ ...update, patch: { actor: 'model', status: 'completed' } }],
      [{ ...update, patch: { evidenceStatus: 'sufficient' } }],
      [{ ...update, patch: { projectId: 'other-project' } }],
      [{ ...update, expectedVersion: 0 }],
      [{ ...update, expectedCriteriaVersion: -1 }],
      [{ ...update, expectedManualVersion: -1 }],
      [{ ...update, expectedVersion: 1.5 }],
      [{ ...update, expectedVersion: '1' }],
      [{ ...update, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }],
      [{ method: 'workspace.list', query: { limit: 101 } }],
      [
        {
          method: 'credentials.importFile',
          label: 'test',
          domain: 'api.example.com',
          purpose: 'source',
          path: '/tmp/forged-secret.txt',
        },
      ],
      [
        {
          method: 'credentials.importFile',
          label: 'test',
          domain: 'api.example.com',
          purpose: 'source',
          secret: 'forged-secret',
        },
      ],
      [
        {
          method: 'credentials.importFile',
          label: 'test',
          domain: '127.0.0.1',
          purpose: 'source',
        },
      ],
      [{ method: 'credentials.list', ciphertext: 'forged' }],
      [{ method: 'credentials.getSecret', id: 'c' }],
      [{ method: 'exports.build', projectId: 'p', includeSourceText: false }],
      [
        {
          method: 'exports.save',
          projectId: 'p',
          includeSourceText: false,
          path: '/tmp/forged.json',
        },
      ],
      [{ method: 'exports.save', projectId: 'p' }],
      [
        {
          method: 'exports.save',
          projectId: 'p',
          includeSourceText: false,
          taskIds: ['t', 't'],
        },
      ],
      [
        {
          method: 'exports.save',
          projectId: 'p',
          includeSourceText: false,
          includeCredentials: true,
        },
      ],
      [
        {
          method: 'sources.importFile',
          projectId: 'p',
          path: '/tmp/forged.jsonl',
        },
      ],
      [
        {
          method: 'sources.chooseFile',
          projectId: 'p',
          path: '/tmp/forged.jsonl',
        },
      ],
      [{ method: 'sources.list', cursor: 'forged' }],
      [{ method: 'sources.sync', id: 's', path: '/tmp/forged.jsonl' }],
      [{ method: 'sources.revoke', id: 's', grantVersion: 99 }],
      [
        {
          method: 'workspace.detail',
          projectId: 'project-1',
          id: 'task-1',
          criteriaVersion: -1,
        },
      ],
      [{ ...update, patch: { dueAt: '2026-02-30T12:00:00Z' } }],
      [{ ...update, patch: { admission: 'automatic' } }],
      [
        {
          method: 'workspace.replaceCriteria',
          projectId: 'p',
          id: 't',
          expectedVersion: 1,
          expectedCriteriaVersion: 0,
          expectedManualVersion: 0,
          criteria: [{ id: 'a', description: 'x', actorId: 'forged' }],
        },
      ],
    ]) {
      expect(
        await page.evaluate(
          (args) =>
            (window as unknown as ProbeWindow).securityProbe.request(...args),
          args,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    }
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (
              await (window as unknown as ProbeWindow).securityProbe.request({
                method: 'health',
              })
            ).ok,
        ),
      )
      .toBe(true)
    // A syntactically valid unknown project must not create an orphaned task.
    const missingProject = await page.evaluate(() =>
      (window as unknown as ProbeWindow).securityProbe.request({
        method: 'workspace.createTask',
        projectId: 'nonexistent-project',
        title: 'Never persisted',
      }),
    )
    expect(missingProject.ok).toBe(false)
    expect(await page.evaluate(() => window.memo.workspace.list())).toEqual({
      ok: true,
      data: {
        projects: [],
        tasks: [],
        nextCursor: null,
        totalCount: 0,
        activeCount: 0,
      },
    })
    // Identical URL in another actual WebContents must still fail identity validation.
    const foreignReady = app.waitForEvent('window')
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      })
      await foreign.loadURL(url)
    }, url)
    const foreign = await foreignReady
    expect(
      await foreign.evaluate(() =>
        (window as unknown as ProbeWindow).securityProbe.request({
          method: 'health',
        }),
      ),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(
      await foreign.evaluate(() =>
        (window as unknown as ProbeWindow).securityProbe.request({
          method: 'workspace.list',
        }),
      ),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(
      await foreign.evaluate(() =>
        (window as unknown as ProbeWindow).securityProbe.request({
          method: 'workspace.createProject',
          name: 'Unauthorized project',
        }),
      ),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(await page.evaluate(() => window.memo.workspace.list())).toEqual({
      ok: true,
      data: {
        projects: [],
        tasks: [],
        nextCursor: null,
        totalCount: 0,
        activeCount: 0,
      },
    })
    for (const request of [
      { method: 'workspace.detail', projectId: 'p', id: 't' },
      {
        method: 'workspace.replaceCriteria',
        projectId: 'p',
        id: 't',
        expectedVersion: 1,
        expectedCriteriaVersion: 0,
        expectedManualVersion: 0,
        criteria: [],
      },
    ])
      expect(
        await foreign.evaluate(
          (request) =>
            (window as unknown as ProbeWindow).securityProbe.request(request),
          request,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    for (const request of [
      { method: 'sources.list' },
      { method: 'sources.chooseFile', projectId: 'p' },
      { method: 'sources.sync', id: 's' },
      { method: 'sources.revoke', id: 's' },
    ])
      expect(
        await foreign.evaluate(
          (request) =>
            (window as unknown as ProbeWindow).securityProbe.request(request),
          request,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(await page.evaluate(() => window.memo.sources.list())).toEqual({
      ok: true,
      data: { sources: [] },
    })
    expect(
      await foreign.evaluate(() =>
        (window as unknown as ProbeWindow).securityProbe.request({
          method: 'exports.save',
          projectId: 'p',
          includeSourceText: false,
        }),
      ),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    for (const request of [
      { method: 'credentials.list' },
      {
        method: 'credentials.importFile',
        label: 'test',
        domain: 'api.example.com',
        purpose: 'source',
      },
      { method: 'credentials.remove', id: 'credential-1' },
    ])
      expect(
        await foreign.evaluate(
          (request) =>
            (window as unknown as ProbeWindow).securityProbe.request(request),
          request,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    for (const request of [
      { method: 'plugins.list' },
      { method: 'plugins.inspect' },
      { method: 'plugins.trial', inspectionId: 'i', projectId: 'p' },
      { method: 'plugins.activate', trialId: 't' },
      { method: 'plugins.disable', id: 'plugin-1' },
      { method: 'plugins.uninstall', id: 'plugin-1' },
      { method: 'plugins.sync', id: 'plugin-1' },
    ])
      expect(
        await foreign.evaluate(
          (request) =>
            (window as unknown as ProbeWindow).securityProbe.request(request),
          request,
        ),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(await page.evaluate(() => window.memo.plugins.list())).toEqual({
      ok: true,
      data: { plugins: [] },
    })
    // Production CSP denies embedding even a same-origin frame.
    await page.evaluate((url) => {
      const frame = document.createElement('iframe')
      frame.src = url
      document.body.append(frame)
    }, url)
    await expect
      .poll(() => page.frames().filter((frame) => frame.url() === url).length)
      .toBe(1)
    await page.getByRole('button', { name: /来源记录\s*3/ }).click()
    await page.getByRole('button', { name: /完成修复与本地测试/ }).click()
    await expect(page.locator('.evidence-content')).toContainText(payload)
    expect(fixtureReplaced).toBe(true)
    expect(
      await page
        .locator('.evidence-content script, .evidence-content img')
        .count(),
    ).toBe(0)
    expect(
      await page.evaluate(
        () => (window as unknown as ProbeWindow).__sourceExecuted,
      ),
    ).toBeUndefined()
    // Relax only the test server's CSP to verify subframes receive neither the app bridge nor the test preload.
    // The senderFrame rejection itself is covered in security.test.ts.
    allowTestFrame = true
    await page.reload()
    await page.evaluate((url) => {
      const frame = document.createElement('iframe')
      frame.src = url
      document.body.append(frame)
    }, url)
    await expect
      .poll(() => page.frames().filter((frame) => frame.url() === url).length)
      .toBe(2)
    const child = page
      .frames()
      .find((frame) => frame !== page.mainFrame() && frame.url() === url)!
    await child.waitForLoadState('domcontentloaded')
    expect(
      await child.evaluate(() => ({
        probe: typeof (window as unknown as ProbeWindow).securityProbe,
        bridge: typeof window.memo,
        node: typeof (globalThis as unknown as { require: unknown }).require,
      })),
    ).toEqual({ probe: 'undefined', bridge: 'undefined', node: 'undefined' })
  } finally {
    // Window close is deliberately intercepted by the tray; quit the app itself.
    await app.evaluate(({ app }) => app.quit()).catch(() => {})
    await app.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    await rm(data, { recursive: true, force: true })
  }
})

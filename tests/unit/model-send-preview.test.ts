import { it, expect, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const calls = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../apps/desktop/src/main/task-api-provider', () => ({
  modelEndpoint: (c: { baseUrl: string }) => new URL(c.baseUrl),
  callModelApi: calls.api,
}))
vi.mock('../../apps/desktop/src/main/task-cli-provider', () => ({
  findModelCli: async () => null,
  callModelCli: vi.fn(),
}))
import { createTaskModelProvider } from '../../apps/desktop/src/main/task-model-provider'
it('previews actual context, omits auth, cancels and blocks all new requests after disable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugu-model-preview-'))
  try {
    const path = join(dir, 'model.json')
    const provider = createTaskModelProvider(
      path,
      async () => 'synthetic-secret',
    )
    const config = {
      provider: 'responses' as const,
      enabled: true,
      baseUrl: 'https://example.test/v1',
      model: 'fixture',
      credentialId: 'key-ref',
    }
    await provider.configure(config)
    const input = {
      messages: [{ role: 'user' as const, content: 'synthetic session only' }],
      schema: {},
      signal: new AbortController().signal,
    }
    calls.api.mockResolvedValueOnce('{"tasks":[]}')
    await provider.analyze(input)
    const preview = (await provider.status()).lastRequest!
    expect(preview.messages).toEqual(input.messages)
    expect(preview.destination).toBe('https://example.test')
    expect(JSON.stringify(preview)).not.toContain('synthetic-secret')
    expect(await readFile(path, 'utf8')).not.toContain('synthetic session')
    preview.messages[0]!.content = 'mutated'
    expect((await provider.status()).lastRequest!.messages[0]!.content).toBe(
      'synthetic session only',
    )
    let signal: AbortSignal | undefined
    calls.api.mockImplementationOnce(
      async (_: unknown, r: { signal: AbortSignal }) => {
        signal = r.signal
        await new Promise<void>((resolve) =>
          r.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        return '{}'
      },
    )
    const pending = provider.analyze(input)
    const rejection = expect(pending).rejects.toThrow('MODEL_CANCELLED')
    await vi.waitFor(() => expect(signal).toBeDefined())
    await provider.configure({ ...config, enabled: false })
    await rejection
    expect(signal!.aborted).toBe(true)
    await expect(provider.analyze(input)).rejects.toThrow(
      'MODEL_NOT_CONFIGURED',
    )
    expect(calls.api).toHaveBeenCalledTimes(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('does not start transport if disabled while credential lookup is pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugu-model-race-'))
  try {
    let resolve!: (value: string) => void
    const secret = new Promise<string>((r) => (resolve = r))
    const provider = createTaskModelProvider(join(dir, 'config'), () => secret)
    const config = {
      provider: 'responses' as const,
      enabled: true,
      baseUrl: 'https://example.test/v1',
      model: 'fixture',
      credentialId: 'key',
    }
    await provider.configure(config)
    const before = calls.api.mock.calls.length
    const pending = provider.analyze({
      messages: [{ role: 'user', content: 'safe' }],
      schema: {},
      signal: new AbortController().signal,
    })
    const rejection = expect(pending).rejects.toThrow('MODEL_CANCELLED')
    await new Promise((r) => setTimeout(r, 5))
    await provider.configure({ ...config, enabled: false })
    resolve('fixture-key')
    await rejection
    expect(calls.api.mock.calls.length).toBe(before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

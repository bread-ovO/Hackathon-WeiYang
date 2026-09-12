import { describe, it, expect, vi } from 'vitest'
import { createPluginRuntime } from '../../apps/desktop/src/main/plugin-runtime'
import {
  HTTP_JSON_MANIFEST_EXAMPLE,
  HttpTransportError,
} from '../../packages/plugin-host/src/index'
import type { HostRequest } from '@memo/contracts'
function fixture() {
  let time = 1_000_000
  const manifest = structuredClone(HTTP_JSON_MANIFEST_EXAMPLE)
  const binding = {
    id: manifest.id,
    projectId: 'p',
    displayName: 'test',
    version: '1.0.0',
    digest: 'a'.repeat(64),
    status: 'active' as string,
    grantVersion: 1,
    lastSuccessAt: null as string | null,
    eventCount: 0,
    manifest,
    sourceInstanceId: 'source-1',
    cursor: '',
    grant: {
      kind: 'http-json',
      domain: 'api.example.com',
      credentialId: 'credential-1',
    },
  }
  const request = vi.fn(async (req: HostRequest) => {
    if (req.method === 'pluginHost.list')
      return {
        ok: true as const,
        data: [
          {
            id: binding.id,
            projectId: 'p',
            displayName: 'test',
            version: '1.0.0',
            digest: binding.digest,
            status: binding.status,
            grantVersion: binding.grantVersion,
            lastSuccessAt: binding.lastSuccessAt,
            eventCount: binding.eventCount,
          },
        ],
      }
    if (req.method === 'pluginHost.get')
      return { ok: true as const, data: structuredClone(binding) }
    if (req.method === 'pluginHost.recordError') binding.status = 'error'
    if (req.method === 'pluginHost.disable') binding.status = 'disabled'
    if (req.method === 'pluginHost.receiveBatch') {
      binding.lastSuccessAt = new Date(time).toISOString()
      binding.cursor = req.input.cursor
      binding.eventCount += req.input.events.length
    }
    return { ok: true as const, data: {} }
  })
  const transport = vi.fn(async () =>
    Buffer.from(JSON.stringify({ items: [], next_cursor: null })),
  )
  const runtime = createPluginRuntime({
    request,
    choose: async () => null,
    readCredential: async () => 'fictional-token',
    transport,
    now: () => time,
  })
  return {
    runtime,
    transport,
    request,
    binding,
    advance: (ms: number) => {
      time += ms
    },
    now: () => time,
  }
}
describe('active plugin network recovery', () => {
  it('backs off a transient failure without advancing cursor or last success, then resumes', async () => {
    const f = fixture()
    f.transport.mockRejectedValueOnce(new HttpTransportError('HTTP_TIMEOUT'))
    await f.runtime.tick()
    expect(f.binding.lastSuccessAt).toBeNull()
    expect(f.binding.cursor).toBe('')
    expect(f.binding.status).toBe('active')
    const snapshot = await f.runtime.handle({ method: 'plugins.list' })
    expect(snapshot.ok && snapshot.data.plugins[0]?.runtime).toEqual({
      state: 'retrying',
      retryAttempt: 1,
      nextRetryAt: new Date(f.now() + 300000).toISOString(),
    })
    await f.runtime.tick()
    await f.runtime.handle({ method: 'plugins.sync', id: f.binding.id })
    expect(f.transport).toHaveBeenCalledTimes(1)
    f.advance(299999)
    await f.runtime.tick()
    expect(f.transport).toHaveBeenCalledTimes(1)
    f.advance(1)
    await f.runtime.tick()
    expect(f.transport).toHaveBeenCalledTimes(2)
    expect(f.binding.lastSuccessAt).toBe(new Date(f.now()).toISOString())
    const ready = await f.runtime.handle({ method: 'plugins.list' })
    expect(ready.ok && ready.data.plugins[0]?.runtime?.state).toBe('waiting')
  })
  it('increases delay and pauses after three transport failures', async () => {
    const f = fixture()
    f.transport.mockRejectedValue(new HttpTransportError('HTTP_REQUEST_FAILED'))
    await f.runtime.tick()
    f.advance(300000)
    await f.runtime.tick()
    f.advance(300000)
    await f.runtime.tick()
    expect(f.transport).toHaveBeenCalledTimes(2)
    f.advance(300000)
    await f.runtime.tick()
    expect(f.transport).toHaveBeenCalledTimes(3)
    expect(f.binding.status).toBe('error')
    f.advance(3600000)
    await f.runtime.tick()
    expect(f.transport).toHaveBeenCalledTimes(3)
  })
  it.each([
    'HTTP_ADDRESS_DENIED',
    'HTTP_REDIRECT_DENIED',
    'HTTP_RESPONSE_INVALID',
  ] as const)(
    'does not retry permission or invalid-response failure %s',
    async (code) => {
      const f = fixture()
      f.transport.mockRejectedValue(new HttpTransportError(code))
      await f.runtime.tick()
      expect(f.binding.status).toBe('error')
      f.advance(3600000)
      await f.runtime.tick()
      expect(f.transport).toHaveBeenCalledTimes(1)
    },
  )
  it('disable cancels a planned retry and does not fabricate successful ingestion', async () => {
    const f = fixture()
    f.transport.mockRejectedValue(new HttpTransportError('HTTP_TIMEOUT'))
    await f.runtime.tick()
    await f.runtime.handle({ method: 'plugins.disable', id: f.binding.id })
    f.advance(3600000)
    await f.runtime.tick()
    expect(f.transport).toHaveBeenCalledTimes(1)
    expect(f.binding.lastSuccessAt).toBeNull()
  })
  it('does not blindly retry an uncertain database commit as a transport failure', async () => {
    const f = fixture()
    f.request.mockImplementationOnce(async () => ({
      ok: true as const,
      data: [f.binding],
    }))
    f.request.mockImplementationOnce(async () => ({
      ok: true as const,
      data: f.binding,
    }))
    f.request.mockImplementationOnce(async () => {
      throw new HttpTransportError('HTTP_TIMEOUT')
    })
    await f.runtime.tick()
    expect(f.binding.status).toBe('error')
  })
})

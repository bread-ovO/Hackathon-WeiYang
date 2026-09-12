import { describe, expect, it, vi } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'
const input = {
  label: '飞书只读凭据',
  domain: 'open.feishu.cn',
  purpose: 'source',
}
const request = { method: 'credentials.importFile', ...input }
const invalid = [
  { ...request, label: '' },
  { ...request, label: '   ' },
  { ...request, label: 'x'.repeat(81) },
  { ...request, label: 'label\0secret' },
  { ...request, purpose: 'admin' },
  { ...request, purpose: null },
  { ...request, path: '/private/token.txt' },
  { ...request, secret: 'should-never-cross-ipc' },
  { ...request, ciphertext: 'forged' },
  { ...request, keychainReference: 'forged' },
  { method: 'credentials.list', path: '/private' },
  { method: 'credentials.remove', id: '' },
  { method: 'credentials.remove', id: 'x'.repeat(129) },
  { method: 'credentials.remove', id: 'id\n' },
  { method: 'credentials.remove', id: 1 },
  {
    method: 'credentials.remove',
    id: 'credential-1',
    domain: 'other.example.com',
  },
  { method: 'credentials.decrypt', id: 'credential-1' },
  { method: 'credentials.getSecret', id: 'credential-1' },
]
for (const domain of [
  '',
  'localhost',
  '127.0.0.1',
  '[::1]',
  '2130706433',
  '0x7f000001',
  'https://open.feishu.cn',
  'OPEN.FEISHU.CN',
  'open.feishu.cn:443',
  'open.feishu.cn.',
  ' open.feishu.cn',
  'open.feishu.cn/path',
  'name@open.feishu.cn',
  '%6fpen.feishu.cn',
  '*.feishu.cn',
  'bad_label.example',
  `${'x'.repeat(64)}.example`,
  `${'x'.repeat(63)}.${'x'.repeat(63)}.${'x'.repeat(63)}.${'x'.repeat(63)}.com`,
])
  invalid.push({ ...request, domain })

describe('main-only credential operations', () => {
  it('accepts scoped metadata but never asks the renderer to handle a secret', () => {
    for (const value of [
      request,
      { ...request, purpose: 'model', domain: 'api.example.com' },
      { method: 'credentials.list' },
      {
        method: 'credentials.remove',
        id: 'a66f89c7-92b7-4f5d-a99a-9c72a9f34388',
      },
    ])
      expect(parseCoreRequest(value)).toEqual(value)
  })
  it.each(invalid)(
    'rejects invalid metadata or secret/path access %#',
    (value) => {
      expect(() => parseCoreRequest(value)).toThrow('INVALID_REQUEST')
    },
  )
  it('does not forward any credential method to the core process', () => {
    for (const value of [
      request,
      { method: 'credentials.list' },
      { method: 'credentials.remove', id: 'credential-1' },
    ])
      expect(() => parseHostRequest(value)).toThrow('INVALID_REQUEST')
  })
  it('rejects foreign/child-frame requests and malformed metadata before opening native UI', async () => {
    const frame = { url: 'memo://app/index.html' }
    const renderer = { mainFrame: frame, isDestroyed: () => false }
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      data: { credentials: [], encryptionAvailable: false },
    }))
    const handler = createRequestHandler(() => renderer, frame.url, dispatch)
    for (const event of [
      { sender: {}, senderFrame: frame },
      { sender: renderer, senderFrame: { url: frame.url } },
    ]) {
      for (const value of [
        request,
        { method: 'credentials.list' },
        { method: 'credentials.remove', id: 'credential-1' },
      ])
        expect(await handler(event, value)).toEqual({
          ok: false,
          error: 'INVALID_REQUEST',
        })
    }
    for (const value of invalid)
      expect(
        await handler({ sender: renderer, senderFrame: frame }, value),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(
      await handler({ sender: renderer, senderFrame: frame }, request, 'extra'),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(dispatch).not.toHaveBeenCalled()
  })
})

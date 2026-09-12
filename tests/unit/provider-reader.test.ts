import { describe, it, expect, vi } from 'vitest'
import { createProviderSourceReader } from '../../apps/desktop/src/main/provider-reader'
const pr = {
  number: 1,
  title: 'Fictional PR',
  html_url: 'https://github.com/org/project/pull/1',
  url: 'https://api.github.com/repos/org/project/pulls/1',
  state: 'open',
  merged_at: null,
  updated_at: '2026-09-13T00:00:00Z',
  draft: false,
  base: {
    ref: 'main',
    sha: 'a'.repeat(40),
    repo: { id: 123, full_name: 'org/project' },
  },
  head: {
    ref: 'feature',
    sha: 'b'.repeat(40),
    label: 'fork:feature',
    repo: { full_name: 'fork/project' },
  },
}
describe('host provider credential binding', () => {
  it('resolves the selected credential on every conditional request without leaking adapter placeholder', async () => {
    const readCredential = vi
      .fn()
      .mockResolvedValueOnce('fictional-one')
      .mockResolvedValueOnce('fictional-two')
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: { etag: '"v1"' },
        body: [pr],
      })
      .mockResolvedValueOnce({ status: 304, headers: {}, body: null })
    const mutable = {
      id: 'installed-source',
      credentialId: 'vault-1',
      kind: 'github' as const,
      owner: 'org',
      repo: 'project',
    }
    const reader = createProviderSourceReader(mutable, {
      readCredential,
      transport,
    })
    mutable.credentialId = 'other'
    mutable.repo = 'other'
    const first = await reader.pull('', new AbortController().signal),
      second = await reader.pull('', new AbortController().signal)
    expect(first).toEqual(second)
    expect(first.events[0]!.sourceInstanceId).toBe('installed-source')
    expect(readCredential.mock.calls).toEqual([
      ['vault-1', { domain: 'api.github.com', purpose: 'source' }],
      ['vault-1', { domain: 'api.github.com', purpose: 'source' }],
    ])
    expect(transport.mock.calls.map(([x]) => x.bearerToken)).toEqual([
      'fictional-one',
      'fictional-two',
    ])
    expect(transport.mock.calls[1]![0].headers['If-None-Match']).toBe('"v1"')
    expect(JSON.stringify(first)).not.toMatch(
      /fictional-one|fictional-two|host-managed/,
    )
  })
  it('does not reuse cached credential after vault removal', async () => {
    const readCredential = vi
      .fn()
      .mockResolvedValueOnce('fictional-token')
      .mockRejectedValueOnce(new Error('VAULT_NOT_FOUND'))
    const transport = vi
      .fn()
      .mockResolvedValue({ status: 200, headers: { etag: '"v1"' }, body: [pr] })
    const reader = createProviderSourceReader(
      {
        id: 'source',
        credentialId: 'vault',
        kind: 'github',
        owner: 'org',
        repo: 'project',
      },
      { readCredential, transport },
    )
    await reader.pull('', new AbortController().signal)
    await expect(
      reader.pull('', new AbortController().signal),
    ).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('does not request HTTP if cancelled while awaiting vault', async () => {
    const controller = new AbortController(),
      transport = vi.fn()
    const reader = createProviderSourceReader(
      {
        id: 'source',
        credentialId: 'vault',
        kind: 'github',
        owner: 'org',
        repo: 'project',
      },
      {
        readCredential: async () => {
          controller.abort()
          return 'fictional-token'
        },
        transport,
      },
    )
    await expect(reader.pull('', controller.signal)).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
  it('binds Feishu conversation and source scope before reading', async () => {
    const readCredential = vi.fn().mockResolvedValue('fictional-token')
    const transport = vi
      .fn()
      .mockResolvedValue({
        status: 200,
        headers: {},
        body: {
          code: 0,
          data: {
            items: [
              {
                message_id: 'm1',
                create_time: '1789257600000',
                sender: { sender_type: 'user' },
                body: { content: '{"text":"Fictional message"}' },
              },
            ],
            has_more: false,
          },
        },
      })
    const reader = createProviderSourceReader(
      {
        id: 'source-feishu',
        credentialId: 'vault',
        kind: 'feishu',
        chatId: 'oc_test',
      },
      { readCredential, transport },
    )
    const result = await reader.pull('', new AbortController().signal)
    expect(readCredential).toHaveBeenCalledWith('vault', {
      domain: 'open.feishu.cn',
      purpose: 'source',
    })
    expect(transport.mock.calls[0]![0].url).toContain('container_id=oc_test')
    expect(result.events[0]).toMatchObject({
      sourceInstanceId: 'source-feishu',
      role: 'user',
      text: 'Fictional message',
    })
  })
})

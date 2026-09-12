import { describe, expect, it, vi } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'
const trial = {
  method: 'plugins.trial',
  inspectionId: 'inspection-1',
  projectId: 'project-1',
}
const publicRequests = [
  { method: 'plugins.list' },
  { method: 'plugins.inspect' },
  trial,
  { ...trial, credentialId: 'credential-1' },
  { method: 'plugins.activate', trialId: 'trial-1' },
  ...['disable', 'uninstall', 'sync'].map((method) => ({
    method: `plugins.${method}`,
    id: 'plugin-1',
  })),
]
const activation = {
  method: 'pluginHost.activate',
  input: {
    id: 'plugin-1',
    projectId: 'project-1',
    displayName: '插件',
    version: '1.0.0',
    digest: 'a'.repeat(64),
    manifest: {},
    grant: {
      kind: 'http-json',
      domain: 'api.example.com',
      credentialId: 'credential-1',
    },
  },
}
const event = {
  schemaVersion: 1,
  sourceInstanceId: 'plugin-1',
  externalId: 'event-1',
  revision: '1',
  occurredAt: '2026-09-13T00:00:00Z',
  role: 'user',
  text: 'synthetic fixture',
}
const batch = {
  method: 'pluginHost.receiveBatch',
  input: {
    id: 'plugin-1',
    grantVersion: 1,
    expectedCursor: '',
    cursor: 'next',
    events: [event],
  },
}
const internalRequests = [
  { method: 'pluginHost.list' },
  { method: 'pluginHost.get', id: 'plugin-1' },
  activation,
  batch,
  ...['disable', 'uninstall'].map((method) => ({
    method: `pluginHost.${method}`,
    id: 'plugin-1',
  })),
  { method: 'pluginHost.recordError', id: 'plugin-1', grantVersion: 1 },
]
const invalidPublic = [
  { ...trial, inspectionId: '' },
  { ...trial, inspectionId: 'x'.repeat(129) },
  { ...trial, projectId: null },
  { ...trial, projectId: 'x'.repeat(257) },
  { ...trial, credentialId: '' },
  { ...trial, credentialId: 'x'.repeat(129) },
  { ...trial, token: 'forged' },
  { ...trial, path: '/tmp/events.jsonl' },
  { ...trial, manifest: {} },
  { method: 'plugins.inspect', path: '/tmp/manifest.json' },
  { method: 'plugins.activate', trialId: 'trial-1', manifest: {} },
  { method: 'plugins.activate', trialId: '' },
  { method: 'plugins.list', token: 'forged' },
  { method: 'plugins.sync', id: '\0' },
  { method: 'plugins.disable', id: 'plugin-1', grantVersion: 999 },
  { method: 'plugins.uninstall', id: 'plugin-1', deleteHistory: true },
]

describe('plugin public and host IPC separation', () => {
  it.each(publicRequests)(
    'accepts public method but never forwards it into core %#',
    (request) => {
      expect(parseCoreRequest(request)).toEqual(request)
      expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
    },
  )
  it.each(internalRequests)(
    'accepts host method but never exposes it to renderer %#',
    (request) => {
      expect(parseHostRequest(request)).toEqual(request)
      expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
    },
  )
  it.each(invalidPublic)('rejects forged plugin input %#', (request) => {
    expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
  })
  it('rejects untrusted windows, child frames and malformed public input before dispatch', async () => {
    const frame = { url: 'memo://app/index.html' }
    const renderer = { mainFrame: frame, isDestroyed: () => false }
    const dispatch = vi.fn(async () => ({
      ok: true as const,
      data: { plugins: [] },
    }))
    const handler = createRequestHandler(() => renderer, frame.url, dispatch)
    for (const request of publicRequests) {
      for (const sender of [
        { sender: {}, senderFrame: frame },
        { sender: renderer, senderFrame: { url: frame.url } },
      ])
        expect(await handler(sender, request)).toEqual({
          ok: false,
          error: 'INVALID_REQUEST',
        })
    }
    for (const request of [...invalidPublic, ...internalRequests])
      expect(
        await handler({ sender: renderer, senderFrame: frame }, request),
      ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it.each([
    {
      ...activation,
      input: { ...activation.input, manifest: { large: '字'.repeat(24000) } },
    },
    {
      ...activation,
      input: {
        ...activation.input,
        manifest: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [String(i), 'x']),
        ),
      },
    },
    {
      ...batch,
      input: {
        ...batch.input,
        events: Array.from({ length: 501 }, () => event),
      },
    },
    { ...activation, input: { ...activation.input, digest: 'forged' } },
    { ...activation, input: { ...activation.input, token: 'forged' } },
    {
      ...activation,
      input: {
        ...activation.input,
        grant: {
          kind: 'http-json',
          domain: 'api.example.com',
          token: 'forged',
        },
      },
    },
    {
      ...activation,
      input: {
        ...activation.input,
        grant: { kind: 'local-jsonl', path: '../events.jsonl' },
      },
    },
    { ...batch, input: { ...batch.input, grantVersion: 0 } },
    {
      ...batch,
      input: { ...batch.input, grantVersion: Number.MAX_SAFE_INTEGER + 1 },
    },
    { ...batch, input: { ...batch.input, cursor: 'x'.repeat(65537) } },
    {
      ...batch,
      input: { ...batch.input, events: [{ ...event, role: 'admin' }] },
    },
    {
      ...batch,
      input: {
        ...batch.input,
        events: [{ ...event, occurredAt: '2026-02-30T00:00:00Z' }],
      },
    },
    {
      ...batch,
      input: {
        ...batch.input,
        events: [{ ...event, text: 'x'.repeat(65537) }],
      },
    },
    {
      ...batch,
      input: { ...batch.input, events: [{ ...event, execute: 'shell' }] },
    },
    {
      method: 'pluginHost.recordError',
      id: 'p',
      grantVersion: 1,
      message: '/private/token',
    },
  ])(
    'validates bounded internal operations independently of public parsing %#',
    (request) => {
      expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
    },
  )
})

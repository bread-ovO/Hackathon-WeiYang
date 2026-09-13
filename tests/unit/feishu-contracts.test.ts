import { expect, it } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
const id = '00000000-0000-4000-8000-000000000001',
  scope = {
    projectId: 'p',
    chatId: 'oc_fixture',
    credentialId: id,
    startTime: 1000,
  }
it.each([
  { method: 'feishu.list' },
  { method: 'feishu.connect', ...scope },
  { method: 'feishu.setEnabled', id, enabled: false },
  { method: 'feishu.revoke', id },
  { method: 'feishu.sync', id },
  { method: 'feishu.restartWindow', id },
  { method: 'feishu.records', id, limit: 50 },
])('public Feishu operations remain in main %#', (request) => {
  expect(parseCoreRequest(request)).toEqual(request)
  expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
})
it.each([
  { ...scope, chatId: 'other' },
  { ...scope, chatId: 'oc_a/b' },
  { ...scope, credentialId: 'token' },
  { ...scope, startTime: 1001 },
  { ...scope, startTime: -1000 },
  { ...scope, startTime: Infinity },
  { ...scope, token: 'secret' },
  { ...scope, projectId: 'p two' },
  { ...scope, endTime: 2000 },
])('rejects invalid or expanded scope %#', (input) =>
  expect(() =>
    parseCoreRequest({ method: 'feishu.connect', ...input }),
  ).toThrow('INVALID_REQUEST'),
)
it.each([
  { method: 'feishuHost.authorize', input: { ...scope, endTime: 2000 } },
  {
    method: 'feishuHost.beginWindow',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    until: 3000,
  },
  {
    method: 'feishuHost.restartWindow',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
  },
  {
    method: 'feishuHost.recordFailure',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    errorCode: 'FEISHU_PERMISSION_DENIED',
    nextPollAt: 9999,
  },
  { method: 'feishuHost.getCooldown', credentialId: id },
])('host-only methods cannot be supplied by renderer %#', (request) => {
  expect(parseHostRequest(request)).toEqual(request)
  expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
})
it.each([
  {
    method: 'feishuHost.beginWindow',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    until: 3001,
  },
  { method: 'feishuHost.restartWindow', id, expectedGrantVersion: 1 },
  {
    method: 'feishuHost.recordFailure',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    errorCode: 'secret error',
    nextPollAt: 0,
  },
  { method: 'feishuHost.getCooldown', credentialId: id, token: 'secret' },
  { method: 'feishu.records', id, limit: 51 },
])('rejects unfenced or unsafe commands %#', (request) =>
  expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST'),
)
it('bounds a page to fifty events and requires exact window fences', () => {
  const event = {
    schemaVersion: 1,
    sourceInstanceId: id,
    externalId: 'om_1',
    revision: '1',
    occurredAt: '2026-09-13T00:00:00Z',
    role: 'user',
    text: '虚构消息',
  }
  const request = {
    method: 'feishuHost.receiveBatch',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    expectedPageToken: '',
    expectedWindowStart: 0,
    expectedWindowEnd: 2000,
    events: Array.from({ length: 50 }, () => event),
    nextPageToken: 'next',
    nextPollAt: 0,
  }
  expect(parseHostRequest(request)).toEqual(request)
  expect(() =>
    parseHostRequest({ ...request, events: [...request.events, event] }),
  ).toThrow('INVALID_REQUEST')
  expect(() =>
    parseHostRequest({ ...request, expectedWindowStart: 1 }),
  ).toThrow('INVALID_REQUEST')
})

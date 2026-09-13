import { expect, it } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
const id = '00000000-0000-4000-8000-000000000001'
const input = {
  projectId: 'p',
  owner: 'bread-ovO',
  repo: 'Hackathon-WeiYang',
  credentialId: id,
}
it.each([
  { method: 'github.list' },
  { method: 'github.connect', ...input },
  { method: 'github.setEnabled', id, enabled: false },
  { method: 'github.revoke', id },
  { method: 'github.sync', id },
  { method: 'github.records', id, limit: 50 },
])('public Github operations stay in main %#', (request) => {
  expect(parseCoreRequest(request)).toEqual(request)
  expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
})
it.each([
  { ...input, token: 'secret' },
  { ...input, owner: '../other' },
  { ...input, repo: '..' },
  { ...input, repo: 'a/b' },
  { ...input, credentialId: 'rawtoken' },
  { ...input, owner: 'a'.repeat(40) },
  { ...input, projectId: 'with space' },
])('rejects credentials/path injection %#', (input) => {
  expect(() =>
    parseCoreRequest({ method: 'github.connect', ...input }),
  ).toThrow('INVALID_REQUEST')
})
it.each([0, 51, 1.5])('bounds record page size %s', (limit) => {
  expect(() =>
    parseCoreRequest({ method: 'github.records', id, limit }),
  ).toThrow('INVALID_REQUEST')
})
it.each([
  { method: 'githubHost.authorize', input: { ...input, repositoryId: 7 } },
  { method: 'githubHost.get', id },
  {
    method: 'githubHost.receiveBatch',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    expectedCursor: '',
    events: [],
    nextCursor: '2',
    nextPollAt: 1234,
  },
  {
    method: 'githubHost.recordFailure',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    expectedCursor: '',
    errorCode: 'GITHUB_AUTH_FAILED',
    nextPollAt: 1234,
  },
])('host-only operations cannot enter renderer contract %#', (request) => {
  expect(parseHostRequest(request)).toEqual(request)
  expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
})
it('rejects arbitrary error text and raw tokens in host grants', () => {
  expect(() =>
    parseHostRequest({
      method: 'githubHost.recordFailure',
      id,
      expectedGrantVersion: 1,
      expectedPollVersion: 1,
      expectedCursor: '',
      errorCode: 'secret token here',
      nextPollAt: 0,
    }),
  ).toThrow('INVALID_REQUEST')
  expect(() =>
    parseHostRequest({
      method: 'githubHost.authorize',
      input: { ...input, repositoryId: 1, token: 'secret' },
    }),
  ).toThrow('INVALID_REQUEST')
})
it.each([
  { method: 'githubHost.getCooldown', credentialId: id },
  { method: 'githubHost.recordCooldown', credentialId: id, notBefore: 0 },
  {
    method: 'githubHost.recordCooldown',
    credentialId: id,
    notBefore: 8640000000000000,
  },
])('cooldowns stay host-only %#', (request) => {
  expect(parseHostRequest(request)).toEqual(request)
  expect(() => parseCoreRequest(request)).toThrow('INVALID_REQUEST')
})
it.each([
  { method: 'githubHost.getCooldown', credentialId: 'token' },
  { method: 'githubHost.getCooldown', credentialId: id, token: 'secret' },
  { method: 'githubHost.recordCooldown', credentialId: id, notBefore: -1 },
  {
    method: 'githubHost.recordCooldown',
    credentialId: id,
    notBefore: 8640000000000001,
  },
  { method: 'githubHost.recordCooldown', credentialId: id, notBefore: 1.5 },
  { method: 'githubHost.recordCooldown', credentialId: id, notBefore: '1' },
])('rejects invalid cooldown scope or timestamps %#', (request) => {
  expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
})
it('limits host receive to a real 100-record page', () => {
  const event = {
    schemaVersion: 1,
    sourceInstanceId: id,
    externalId: 'pr:1',
    revision: '1',
    occurredAt: '2026-09-13T00:00:00Z',
    role: 'tool',
    text: 'synthetic',
  }
  const request = {
    method: 'githubHost.receiveBatch',
    id,
    expectedGrantVersion: 1,
    expectedPollVersion: 1,
    expectedCursor: '',
    nextCursor: '',
    nextPollAt: 0,
    events: Array.from({ length: 100 }, () => event),
  }
  expect(parseHostRequest(request)).toEqual(request)
  expect(() =>
    parseHostRequest({ ...request, events: [...request.events, event] }),
  ).toThrow('INVALID_REQUEST')
})

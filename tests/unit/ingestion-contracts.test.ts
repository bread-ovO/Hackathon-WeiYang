import { expect, it } from 'vitest'
import { parseCoreRequest, parseHostRequest } from '@memo/contracts'
it.each([
  { method: 'ingestion.status' },
  { method: 'ingestion.configure', patch: { maxQueuedJobs: 1 } },
  {
    method: 'ingestion.configure',
    patch: {
      maxQueuedJobs: 100000,
      maxDatabaseBytes: 8589934592,
      minFreeDiskBytes: 17179869184,
    },
  },
])('permits bounded ingestion control %#', (request) => {
  expect(parseCoreRequest(request)).toEqual(request)
  expect(parseHostRequest(request)).toEqual(request)
})
it.each([
  {},
  { maxQueuedJobs: 0 },
  { maxQueuedJobs: 100001 },
  { maxQueuedJobs: 1.5 },
  { maxQueuedJobs: '10' },
  { maxDatabaseBytes: 1048575 },
  { maxDatabaseBytes: 8589934593 },
  { minFreeDiskBytes: 0 },
  { minFreeDiskBytes: 17179869185 },
  { path: '/private' },
  { maxQueuedJobs: NaN },
  { maxQueuedJobs: Infinity },
])('rejects invalid budgets without coercion %#', (patch) => {
  expect(() =>
    parseCoreRequest({ method: 'ingestion.configure', patch }),
  ).toThrow('INVALID_REQUEST')
})
it.each([
  { method: 'ingestion.status', path: '/private' },
  { method: 'ingestion.configure', patch: { maxQueuedJobs: 2 }, force: true },
])('rejects extra controls %#', (request) => {
  expect(() => parseHostRequest(request)).toThrow('INVALID_REQUEST')
})

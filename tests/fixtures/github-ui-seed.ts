/** Synthetic observations only. No token is stored or network transport invoked. */
import { openStore } from '@memo/storage'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
const profile = join(process.argv[2]!, 'profile')
mkdirSync(profile, { recursive: true })
const store = openStore(join(profile, 'memo.sqlite'))
try {
  store.processing.setEnabled(false)
  store.tasks.createProject('github-fixture', 'GitHub观察验收')
  const connection = store.github.authorize({
    projectId: 'github-fixture',
    owner: 'fictional-owner',
    repo: 'fictional-repository',
    repositoryId: 123,
    credentialId: '00000000-0000-4000-8000-000000000001',
  })
  const events = (['open', 'closed', 'merged'] as const).map((state, i) => {
    const occurredAt = `2026-09-13T00:0${i}:00Z`
    const text = JSON.stringify({
      kind: 'github-pull-request',
      repository: 'fictional-owner/fictional-repository',
      repositoryId: 123,
      number: 1,
      title: '虚构PR观察记录',
      url: 'https://github.com/fictional-owner/fictional-repository/pull/1',
      state,
      draft: false,
      updatedAt: occurredAt,
      createdAt: '2026-09-13T00:00:00Z',
      closedAt: state === 'open' ? null : occurredAt,
      mergedAt: state === 'merged' ? occurredAt : null,
      base: {
        repository: 'fictional-owner/fictional-repository',
        ref: 'main',
        sha: 'a'.repeat(40),
      },
      head: {
        repository: 'fictional-owner/fictional-repository',
        ref: 'feature/fixture',
        sha: 'b'.repeat(40),
        label: 'fictional-owner:feature/fixture',
      },
    })
    return {
      schemaVersion: 1 as const,
      sourceInstanceId: connection.id,
      externalId: 'pr:1',
      revision: String(i + 1),
      occurredAt,
      role: 'tool' as const,
      text,
    }
  })
  store.github.receiveBatch({
    id: connection.id,
    expectedGrantVersion: connection.grantVersion,
    expectedPollVersion: store.github.getAuthorized(connection.id).pollVersion,
    expectedCursor: '',
    events,
    nextCursor: '',
    nextPollAt: Date.now() + 86400000,
  })
  store.github.setEnabled(connection.id, false)
} finally {
  store.close()
}

import { openStore } from '@memo/storage'
import type { SourceEvent } from '@memo/contracts'
import {
  HTTP_JSON_MANIFEST_EXAMPLE,
  LOCAL_JSONL_MANIFEST_EXAMPLE,
} from '../packages/plugin-host/src/manifest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const folder = mkdtempSync(join(tmpdir(), 'bugu-plugin-install-'))
const path = join(folder, 'test.sqlite')
try {
  const store = openStore(path)
  store.tasks.createProject('p', '项目')
  store.tasks.createProject('other', '其他项目')
  const input = {
    id: HTTP_JSON_MANIFEST_EXAMPLE.id,
    projectId: 'p',
    displayName: HTTP_JSON_MANIFEST_EXAMPLE.displayName,
    version: HTTP_JSON_MANIFEST_EXAMPLE.version,
    digest: 'a'.repeat(64),
    manifest: HTTP_JSON_MANIFEST_EXAMPLE,
    grant: {
      kind: 'http-json' as const,
      domain: 'api.example.com',
      credentialId: 'vault-reference-uuid',
    },
  }
  const installed = store.plugins.activate(input)
  assert.equal(installed.status, 'active')
  assert.equal(installed.grantVersion, 1)
  const host = store.plugins.get(installed.id)
  assert.equal('manifest' in installed, false)
  assert.equal('grant' in installed, false)
  assert.equal('sourceInstanceId' in installed, false)
  const event = (id: string): SourceEvent => ({
    schemaVersion: 1,
    sourceInstanceId: host.sourceInstanceId,
    externalId: id,
    revision: '1',
    occurredAt: '2026-09-13T00:00:00Z',
    role: 'user',
    text: '虚构原文',
  })
  const receive = (events: SourceEvent[], cursor = 'p1', expectedCursor = '') =>
    store.plugins.receiveBatch({
      id: installed.id,
      grantVersion: installed.grantVersion,
      events,
      cursor,
      expectedCursor,
    })
  assert.equal(receive([event('a')]).inserted, 1)
  assert.equal(receive([event('a')], 'p1', 'p1').inserted, 0)
  assert.equal(store.health().jobCount, 1)
  assert.throws(
    () => receive([{ ...event('b'), sourceInstanceId: 'fake' }], 'bad', 'p1'),
    /PLUGIN_SOURCE_MISMATCH/,
  )
  assert.throws(
    () => receive([{ ...event('a'), text: 'silent conflict' }], 'bad', 'p1'),
    /SOURCE_REVISION_CONFLICT/,
  )
  assert.throws(() => receive([], 'bad', 'old'), /PLUGIN_CURSOR_CHANGED/)
  assert.throws(() => store.receive(event('bypass'), 'bad'), /USE_AUTHORIZED/)
  const raw = new Database(path)
  assert.equal(
    (
      raw
        .prepare('SELECT count(*) AS n FROM event_projects WHERE project_id=?')
        .get('p') as { n: number }
    ).n,
    1,
  )
  raw.exec(
    "CREATE TRIGGER fail_plugin_link BEFORE INSERT ON event_projects BEGIN SELECT RAISE(ABORT,'FAIL_LINK'); END",
  )
  assert.throws(() => receive([event('b')], 'p2', 'p1'), /FAIL_LINK/)
  assert.equal(store.health().eventCount, 1)
  assert.equal(store.health().jobCount, 1)
  assert.equal(store.plugins.get(installed.id).cursor, 'p1')
  raw.exec('DROP TRIGGER fail_plugin_link')
  assert.throws(
    () => store.plugins.activate({ ...input, digest: 'b'.repeat(64) }),
    /PLUGIN_VERSION_CONFLICT/,
  )
  assert.throws(
    () => store.plugins.activate({ ...input, projectId: 'other' }),
    /PLUGIN_PROJECT_CONFLICT/,
  )
  assert.throws(
    () =>
      store.plugins.activate({
        ...input,
        grant: {
          ...input.grant,
          token: 'MUST_NOT_PERSIST',
        } as typeof input.grant,
      }),
    /PLUGIN_INVALID_DATA/,
  )
  assert.throws(
    () =>
      store.plugins.activate({
        ...input,
        manifest: { ...input.manifest, secret: 'MUST_NOT_PERSIST' },
      }),
    /PLUGIN_INVALID_DATA/,
  )
  assert.equal(store.plugins.get(installed.id).cursor, 'p1')
  const next = {
    ...input,
    version: '1.1.0',
    digest: 'b'.repeat(64),
    manifest: { ...input.manifest, version: '1.1.0' },
  }
  raw.exec(
    "CREATE TRIGGER fail_activation BEFORE UPDATE ON plugin_bindings BEGIN SELECT RAISE(ABORT,'FAIL_ACTIVATE'); END",
  )
  assert.throws(() => store.plugins.activate(next), /FAIL_ACTIVATE/)
  assert.equal(store.plugins.get(installed.id).version, '1.0.0')
  assert.equal(store.plugins.get(installed.id).cursor, 'p1')
  raw.exec('DROP TRIGGER fail_activation')
  const upgrade = store.plugins.activate(next)
  assert.equal(upgrade.grantVersion, 2)
  assert.equal(store.plugins.get(installed.id).cursor, '')
  assert.equal(
    store.plugins.get(installed.id).sourceInstanceId,
    host.sourceInstanceId,
  )
  assert.throws(() => receive([]), /PLUGIN_GRANT_CHANGED/)
  store.plugins.recordError(installed.id, 1)
  assert.equal(store.plugins.get(installed.id).status, 'active')
  store.plugins.recordError(installed.id, 2)
  assert.equal(store.plugins.get(installed.id).status, 'error')
  store.plugins.receiveBatch({
    id: installed.id,
    grantVersion: 2,
    expectedCursor: '',
    cursor: 'retry',
    events: [],
  })
  assert.equal(store.plugins.get(installed.id).status, 'active')
  const disabled = store.plugins.disable(installed.id)
  assert.equal(disabled.status, 'disabled')
  assert.throws(
    () =>
      store.plugins.receiveBatch({
        id: installed.id,
        grantVersion: 2,
        expectedCursor: 'retry',
        cursor: 'bad',
        events: [],
      }),
    /PLUGIN_DISABLED/,
  )
  store.plugins.uninstall(installed.id)
  assert.deepEqual(store.plugins.list(), [])
  assert.throws(() => store.plugins.get(installed.id), /PLUGIN_NOT_FOUND/)
  assert.equal(store.health().eventCount, 1)
  const reinstalled = store.plugins.activate(next)
  const rehost = store.plugins.get(installed.id)
  assert.ok(reinstalled.grantVersion > disabled.grantVersion)
  assert.notEqual(rehost.sourceInstanceId, host.sourceInstanceId)
  assert.throws(
    () =>
      store.plugins.receiveBatch({
        id: installed.id,
        grantVersion: 2,
        expectedCursor: '',
        cursor: 'late',
        events: [],
      }),
    /PLUGIN_GRANT_CHANGED/,
  )
  assert.throws(
    () => store.receive(event('retired-bypass'), 'bad'),
    /USE_AUTHORIZED/,
  )
  const local = {
    id: LOCAL_JSONL_MANIFEST_EXAMPLE.id,
    projectId: 'other',
    displayName: LOCAL_JSONL_MANIFEST_EXAMPLE.displayName,
    version: '1.0.0',
    digest: 'c'.repeat(64),
    manifest: LOCAL_JSONL_MANIFEST_EXAMPLE,
    grant: {
      kind: 'local-jsonl' as const,
      path: join(folder, 'authorized.jsonl'),
    },
  }
  store.plugins.activate(local)
  assert.equal(store.plugins.get(local.id).grant.kind, 'local-jsonl')
  assert.equal(
    JSON.stringify(store.plugins.list()).includes('authorized.jsonl'),
    false,
  )
  assert.equal(
    JSON.stringify(store.plugins.list()).includes('vault-reference'),
    false,
  )
  raw.close()
  store.close()
  const reopen = openStore(path)
  assert.equal(reopen.plugins.list().length, 2)
  assert.equal(reopen.health().schemaVersion, 6)
  reopen.close()
  console.log(
    'Plugin installation integration passed: activate/upgrade rollback, grants, cursor CAS, transactional import, secrets rejection and uninstall/reinstall generations',
  )
} finally {
  rmSync(folder, { recursive: true, force: true })
}

import { openStore } from '@memo/storage'
import type { SourceEvent as Event } from '@memo/contracts'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
const folder = mkdtempSync(join(tmpdir(), 'bugu-source-import-'))
const path = join(folder, 'store.sqlite')
try {
  let store = openStore(path)
  store.tasks.createProject('p', '测试项目')
  store.tasks.createProject('other', '其他项目')
  const file = join(folder, 'fixture.jsonl')
  writeFileSync(file, '')
  let source = store.sources.authorize({ path: file, projectId: 'p' })
  assert.equal(source.grantVersion, 1)
  assert.equal(source.status, 'active')
  assert.equal(source.eventCount, 0)
  assert.equal('path' in source, false)
  assert.equal('cursor' in source, false)
  assert.equal(store.sources.getAuthorized(source.id).path, file)
  const event = (externalId: string, sourceId = source.id): Event => ({
    schemaVersion: 1,
    sourceInstanceId: sourceId,
    externalId,
    revision: '1',
    occurredAt: '2026-09-13T00:00:00Z',
    role: 'user',
    text: '虚构输入',
  })
  assert.throws(
    () => store.sources.authorize({ path: file, projectId: 'missing' }),
    /UNKNOWN_PROJECT/,
  )
  assert.throws(
    () => store.sources.authorize({ path: 'relative.jsonl', projectId: 'p' }),
    /INVALID_SOURCE_PATH/,
  )
  const batch = store.sources.receiveBatch(
    source.id,
    source.grantVersion,
    [event('a'), event('b')],
    'page1',
    '',
  )
  assert.equal(batch.inserted, 2)
  assert.equal(batch.duplicates, 0)
  assert.equal(batch.source.eventCount, 2)
  assert.ok(batch.source.lastSuccessAt)
  const repeat = store.sources.receiveBatch(
    source.id,
    source.grantVersion,
    [event('a'), event('b')],
    'page1',
    'page1',
  )
  assert.equal(repeat.inserted, 0)
  assert.equal(repeat.duplicates, 2)
  assert.equal(store.health().jobCount, 2)
  assert.throws(
    () => store.receive(event('bypass'), 'bad'),
    /USE_AUTHORIZED_SOURCE_BATCH/,
  )
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        source.grantVersion,
        [event('bad', 'wrong')],
        'bad',
        'page1',
      ),
    /IMPORT_INVALID_DATA/,
  )
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        source.grantVersion,
        [{ ...event('a'), text: 'same revision changed' }],
        'bad',
        'page1',
      ),
    /SOURCE_REVISION_CONFLICT/,
  )
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        source.grantVersion,
        [{ ...event('bad'), occurredAt: '2026-02-30T00:00:00Z' }],
        'bad',
        'page1',
      ),
    /IMPORT_INVALID_DATA/,
  )
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        source.grantVersion,
        Array.from({ length: 501 }, () => event('limit')),
        'bad',
        'page1',
      ),
    /IMPORT_LIMIT_EXCEEDED/,
  )
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        source.grantVersion,
        [],
        'page2',
        'outdated',
      ),
    /SOURCE_CURSOR_CHANGED/,
  )
  assert.equal(store.sources.getAuthorized(source.id).cursor, 'page1')
  const raw = new Database(path)
  raw.pragma('foreign_keys=ON')
  assert.equal(
    (
      raw
        .prepare('SELECT count(*) AS n FROM event_projects WHERE project_id=?')
        .get('p') as { n: number }
    ).n,
    2,
  )
  assert.equal(
    (
      raw
        .prepare('SELECT count(*) AS n FROM event_projects WHERE project_id=?')
        .get('other') as { n: number }
    ).n,
    0,
  )
  raw.exec(
    "CREATE TRIGGER fail_project BEFORE INSERT ON event_projects BEGIN SELECT RAISE(ABORT,'SIMULATED_LINK_FAILURE'); END",
  )
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        source.grantVersion,
        [event('c')],
        'page2',
        'page1',
      ),
    /SIMULATED_LINK_FAILURE/,
  )
  assert.equal(store.health().eventCount, 2)
  assert.equal(store.health().jobCount, 2)
  assert.equal(store.sources.getAuthorized(source.id).cursor, 'page1')
  raw.exec('DROP TRIGGER fail_project')
  assert.equal(
    store.sources.recordError(source.id, source.grantVersion, 'INVALID_JSONL'),
    true,
  )
  assert.equal(store.sources.list()[0]?.status, 'error')
  const oldGrant = source.grantVersion
  source = store.sources.revoke(source.id)
  assert.equal(source.status, 'revoked')
  assert.equal(source.grantVersion, oldGrant + 1)
  assert.throws(() => store.sources.getAuthorized(source.id), /SOURCE_REVOKED/)
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        oldGrant,
        [event('c')],
        'bad',
        'page1',
      ),
    /SOURCE_REVOKED/,
  )
  assert.equal(
    store.sources.recordError(source.id, oldGrant, 'INVALID_JSONL'),
    false,
  )
  const reauthorized = store.sources.authorize({ path: file, projectId: 'p' })
  assert.equal(reauthorized.id, source.id)
  assert.equal(reauthorized.grantVersion, source.grantVersion + 1)
  assert.equal(reauthorized.errorCode, null)
  assert.throws(
    () =>
      store.sources.receiveBatch(
        source.id,
        oldGrant,
        [event('c')],
        'bad',
        'page1',
      ),
    /SOURCE_GRANT_CHANGED/,
  )
  const newBatch = store.sources.receiveBatch(
    source.id,
    reauthorized.grantVersion,
    [event('a'), event('c')],
    'page2',
    'page1',
  )
  assert.equal(newBatch.inserted, 1)
  assert.equal(newBatch.duplicates, 1)
  const other = store.sources.authorize({ path: file, projectId: 'other' })
  assert.notEqual(other.id, source.id)
  assert.throws(
    () =>
      store.sources.receiveBatch(
        other.id,
        other.grantVersion,
        [event('cross')],
        'bad',
        '',
      ),
    /IMPORT_INVALID_DATA/,
  )
  store.sources.receiveBatch(other.id, other.grantVersion, [], 'empty', '')
  assert.equal(store.sources.getAuthorized(other.id).cursor, 'empty')
  const summaries = store.sources.list()
  assert.equal(
    summaries.some((s) => 'path' in s || 'cursor' in s),
    false,
  )
  raw.close()
  store.close()
  store = openStore(path)
  assert.equal(store.sources.getAuthorized(source.id).cursor, 'page2')
  assert.equal(store.sources.getAuthorized(source.id).eventCount, 3)
  store.close()
  // v4 existing unmanaged source data stays intact and is never silently authorized.
  const prior = new Database(path)
  prior.exec('DROP TABLE plugin_source_history; DROP TABLE plugin_bindings; DROP TABLE source_grants;PRAGMA user_version=4;')
  prior.close()
  store = openStore(path)
  assert.equal(store.health().schemaVersion, 6)
  assert.equal(store.health().eventCount, 3)
  assert.deepEqual(store.sources.list(), [])
  store.close()
  console.log(
    'Source import integration passed: grants, revoke races, cursor CAS, dedup, project transaction rollback, safety and v4 migration',
  )
} finally {
  rmSync(folder, { recursive: true, force: true })
}

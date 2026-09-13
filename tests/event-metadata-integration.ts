import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
import {
  migrateEventMetadata,
  eventMetadataFields,
} from '../packages/storage/src/event-metadata'
import { HTTP_JSON_MANIFEST_EXAMPLE } from '../packages/plugin-host/src/manifest'
const dir = mkdtempSync(join(tmpdir(), 'bugu-event-metadata-')),
  path = join(dir, 'test.sqlite'),
  store = openStore(path),
  db = new Database(path)
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const grant = store.sources.authorize({
    projectId: 'a',
    path: join(dir, 'synthetic.jsonl'),
  })
  const base: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'm1',
    revision: '1',
    occurredAt: '2026-09-15T00:00:00Z',
    role: 'user',
    text: '我会提交审计文档。',
  }
  const receive = (e: SourceEvent) => {
    const g = store.sources.getAuthorized(grant.id)
    return store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [e],
      e.revision,
      g.cursor,
    )
  }
  receive(base)
  const now = new Date('2026-09-16T00:00:00Z'),
    lease = store.processing.claim(now)!,
    context = store.processing.load(lease, now)!
  assert.equal(context.event.metadata, undefined)
  const task = store.processing.commit(
    lease,
    context,
    prepareEventProcessing({
      event: context.event,
      eventId: context.eventId,
      projectId: 'a',
    }),
    now,
  ).taskIds[0]!
  const metadata = {
    author: { namespace: 'feishu:open_id', subjectId: 'ou_synthetic' },
    replyToExternalId: 'root1',
  }
  const enhanced: SourceEvent = { ...base, revision: '1:context-v1', metadata }
  receive(enhanced)
  const before = store.health().eventCount
  receive({
    ...enhanced,
    metadata: {
      replyToExternalId: 'root1',
      author: { subjectId: 'ou_synthetic', namespace: 'feishu:open_id' },
    },
  })
  assert.equal(store.health().eventCount, before)
  assert.equal(
    (
      db
        .prepare('SELECT count(*) AS n FROM reference_revision_audit')
        .get() as { n: number }
    ).n,
    0,
  )
  for (const changed of [
    undefined,
    { ...metadata, replyToExternalId: 'other' },
    { ...metadata, author: { ...metadata.author, subjectId: 'other' } },
    {
      ...metadata,
      author: { ...metadata.author, namespace: 'feishu:user_id' },
    },
  ]) {
    assert.throws(
      () => receive({ ...enhanced, metadata: changed }),
      /SOURCE_REVISION_CONFLICT/,
    )
    assert.equal(store.health().eventCount, before)
  }
  assert.throws(
    () => receive({ ...base, metadata }),
    /SOURCE_REVISION_CONFLICT/,
  )
  const job = store.processing.claim(now)!,
    loaded = store.processing.load(job, now)!
  assert.deepEqual(loaded.event.metadata, metadata)
  const contextView = store.contexts.get('a', loaded.eventId)!
  assert.deepEqual(contextView.metadata, metadata)
  assert.equal(store.contexts.get('b', loaded.eventId), null)
  store.processing.commit(
    job,
    loaded,
    prepareEventProcessing({
      event: loaded.event,
      eventId: loaded.eventId,
      projectId: 'a',
    }),
    now,
  )
  const exported = store.exports.build({
    projectId: 'a',
    taskIds: [task],
    includeSourceText: false,
  })
  assert.ok(
    exported.events.some(
      (e) =>
        e.revision === '1:context-v1' &&
        JSON.stringify(e.metadata) === JSON.stringify(metadata),
    ),
  )
  assert.ok(
    exported.events
      .filter((e) => e.revision === '1')
      .every((e) => !('metadata' in e)),
  )
  assert.equal(JSON.stringify(exported).includes('metadata_json'), false)
  assert.equal(JSON.stringify(exported).includes('我会提交审计文档。'), false)
  const install = store.plugins.activate({
    id: HTTP_JSON_MANIFEST_EXAMPLE.id,
    projectId: 'a',
    displayName: HTTP_JSON_MANIFEST_EXAMPLE.displayName,
    version: HTTP_JSON_MANIFEST_EXAMPLE.version,
    digest: 'a'.repeat(64),
    manifest: HTTP_JSON_MANIFEST_EXAMPLE,
    grant: {
      kind: 'http-json',
      domain: 'api.example.com',
      credentialId: 'synthetic-vault-reference',
    },
  })
  const p = store.plugins.get(install.id),
    pluginEvent = { ...enhanced, sourceInstanceId: p.sourceInstanceId }
  store.plugins.receiveBatch({
    id: install.id,
    grantVersion: install.grantVersion,
    expectedCursor: '',
    cursor: 'p1',
    events: [pluginEvent],
  })
  assert.throws(
    () =>
      store.plugins.receiveBatch({
        id: install.id,
        grantVersion: install.grantVersion,
        expectedCursor: 'p1',
        cursor: 'bad',
        events: [{ ...pluginEvent, metadata: { replyToExternalId: 'other' } }],
      }),
    /SOURCE_REVISION_CONFLICT/,
  )
  assert.equal(store.plugins.get(install.id).cursor, 'p1')
  const raw = db
    .prepare(
      'SELECT id,metadata_json FROM source_events WHERE source_id=? AND revision=?',
    )
    .get(grant.id, enhanced.revision) as { id: number; metadata_json: string }
  db.prepare('UPDATE source_events SET metadata_json=? WHERE id=?').run(
    '{"author":{"namespace":"x","subjectId":"u","secret":"bad"}}',
    raw.id,
  )
  assert.throws(() => store.contexts.get('a', raw.id), /INVALID_EVENT_METADATA/)
  assert.throws(
    () =>
      store.exports.build({
        projectId: 'a',
        taskIds: [task],
        includeSourceText: false,
      }),
    /EXPORT_CORRUPT_DATA/,
  )
  db.prepare('UPDATE source_events SET metadata_json=? WHERE id=?').run(
    raw.metadata_json,
    raw.id,
  )
  // v14 legacy rows migrate unchanged and omit metadata, with no invented author/reply.
  const legacy = new Database(':memory:')
  legacy.exec(
    "CREATE TABLE source_events(id INTEGER PRIMARY KEY,content TEXT);INSERT INTO source_events VALUES(1,'legacy');PRAGMA user_version=14",
  )
  migrateEventMetadata(legacy)
  assert.deepEqual(legacy.prepare('SELECT * FROM source_events').get(), {
    id: 1,
    content: 'legacy',
    metadata_json: null,
  })
  assert.equal(legacy.pragma('user_version', { simple: true }), 15)
  assert.deepEqual(eventMetadataFields(null), {})
  legacy.close()
  console.log(
    'Event metadata integration passed: immutable upgrade, canonical replay, plugin guard, consumer/context/export and legacy migration',
  )
} finally {
  db.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

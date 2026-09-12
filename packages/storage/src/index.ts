import Database from 'better-sqlite3'
import { createPlugins, migratePlugins } from './plugins'
export type { HostPlugin, SafePlugin, PluginGrant, PluginActivation } from './plugins'
import { createExports } from './export'
export type { ExportBundle, ExportScope } from './export'
export { EXPORT_MAX_BYTES } from './export'
import { createSources, migrateSources } from './sources'
export type { SourceSummary, AuthorizedSource, SourceImportErrorCode } from './sources'
export { sourceImportErrorCodes } from './sources'
import { createTaskModel, migrateTaskModel, migrateTaskEditing } from './task-model'
export type { StoredTask, StoredTaskStatus, StoredAdmission, ManualActor, TaskExpectation, CriterionInput, EvidenceInput, TaskPatch, TaskPageQuery, TaskPage, TaskDecisionSummary } from './task-model'
import { createJobQueue } from './jobs'
import { createCandidateSearch, migrateSearch } from './search'
export type { SearchProjection, CandidateQuery, CandidateHit } from './search'
export type { Job, JobLease, JobErrorCode } from './jobs'
export { MAX_JOB_ATTEMPTS, JOB_LEASE_MS } from './jobs'
import type { SourceEvent, Health } from '@memo/contracts'

export function openStore(path:string) {
  const db = new Database(path)
  try {
    db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL'); db.pragma('busy_timeout = 3000')
    const version = db.pragma('user_version', {simple:true}) as number
    if (version > 6) throw new Error('DATABASE_TOO_NEW')
    if (version < 1) db.transaction(() => {
      db.exec(`
        CREATE TABLE source_instances (id TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '');
        CREATE TABLE source_events (
          id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instances(id),
          external_id TEXT NOT NULL, revision TEXT NOT NULL, occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
          content TEXT NOT NULL, UNIQUE(source_id, external_id, revision)
        );
        CREATE TABLE jobs (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL UNIQUE REFERENCES source_events(id),
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),
          attempt INTEGER NOT NULL DEFAULT 0, lease_until TEXT, next_run TEXT, error_code TEXT);
        CREATE INDEX jobs_pending ON jobs(state, next_run);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('todo','in_progress','waiting','completed','cancelled')),
          evidence_status TEXT NOT NULL CHECK(evidence_status IN ('unknown','partial','sufficient','conflict')),
          version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), archived_at TEXT);
        PRAGMA user_version = 1;
      `)
    })()
    if (version < 2) migrateSearch(db)
    if (version < 3) migrateTaskModel(db)
    if (version < 4) migrateTaskEditing(db)
    if (version < 5) migrateSources(db)
    if (version < 6) migratePlugins(db)
    const receive = db.transaction((event:SourceEvent, cursor:string) => {
      // Do not implicitly authorize/register arbitrary source IDs during ingestion.
      if (!db.prepare('SELECT id FROM source_instances WHERE id = ?').get(event.sourceInstanceId)) throw new Error('UNKNOWN_SOURCE')
      const result = db.prepare(`INSERT INTO source_events
        (source_id,external_id,revision,occurred_at,received_at,role,content) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(source_id,external_id,revision) DO NOTHING`).run(event.sourceInstanceId,event.externalId,event.revision,event.occurredAt,new Date().toISOString(),event.role,event.text)
      if (result.changes) db.prepare('INSERT INTO jobs(event_id) VALUES (?)').run(result.lastInsertRowid)
      db.prepare('UPDATE source_instances SET cursor = ? WHERE id = ?').run(cursor,event.sourceInstanceId)
      return {inserted:result.changes === 1}
    })
    return {
      plugins: createPlugins(db,receive),
      exports: createExports(db),
      sources: createSources(db,receive),
      tasks: createTaskModel(db),
      jobs: createJobQueue(db),
      search: createCandidateSearch(db),
      registerSource(id:string) { db.prepare('INSERT INTO source_instances(id) VALUES (?) ON CONFLICT DO NOTHING').run(id) },
      receive(event:SourceEvent,cursor:string) {
        if(db.prepare('SELECT 1 FROM source_grants WHERE source_id=?').get(event.sourceInstanceId) || db.prepare('SELECT 1 FROM plugin_source_history WHERE source_instance_id=?').get(event.sourceInstanceId))throw new Error('USE_AUTHORIZED_SOURCE_BATCH')
        return receive(event,cursor)
      },
      health():Health { return {status:'ready',schemaVersion:db.pragma('user_version',{simple:true}) as number,
        sqliteVersion:(db.prepare('SELECT sqlite_version() AS version').get() as {version:string}).version,
        eventCount:(db.prepare('SELECT COUNT(*) AS count FROM source_events').get() as {count:number}).count,
        jobCount:(db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {count:number}).count} },
      cursor(id:string) { return (db.prepare('SELECT cursor FROM source_instances WHERE id=?').get(id) as {cursor:string}|undefined)?.cursor },
      close() { db.close() }
    }
  } catch (error) { db.close(); throw error }
}

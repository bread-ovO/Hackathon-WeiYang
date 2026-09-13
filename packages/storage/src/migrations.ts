import Database from 'better-sqlite3'
import { existsSync, mkdirSync, statSync, statfsSync, rmSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { upgradeLegacy, type SourceEvent } from '@memo/contracts'
import { digest, factIdentity } from './util'

export const DATABASE_VERSION = 2
const v1 = `
CREATE TABLE source_instances (id TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT '');
CREATE TABLE source_events (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instances(id), external_id TEXT NOT NULL,
 revision TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, UNIQUE(source_id,external_id,revision));
CREATE TABLE jobs (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL UNIQUE REFERENCES source_events(id), state TEXT NOT NULL DEFAULT 'pending', attempt INTEGER NOT NULL DEFAULT 0, lease_until TEXT, next_run TEXT, error_code TEXT);
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, evidence_status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, archived_at TEXT);
PRAGMA user_version=1;
`
const v2 = `
ALTER TABLE source_instances ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE source_instances ADD COLUMN account_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE source_instances ADD COLUMN tenant_id TEXT;
ALTER TABLE source_instances ADD COLUMN scopes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE source_instances ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1));
ALTER TABLE source_instances ADD COLUMN scope_epoch INTEGER NOT NULL DEFAULT 1 CHECK(scope_epoch>0);
ALTER TABLE source_instances ADD COLUMN revision_basis TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE source_instances ADD COLUMN pause_code TEXT;
CREATE TABLE source_streams (source_id TEXT NOT NULL REFERENCES source_instances(id), id TEXT NOT NULL, scope_id TEXT NOT NULL,
 cursor TEXT NOT NULL DEFAULT '', cursor_version INTEGER NOT NULL DEFAULT 0 CHECK(cursor_version>=0), scope_epoch INTEGER NOT NULL,
 PRIMARY KEY(source_id,id));
INSERT INTO source_streams SELECT id,'legacy','legacy',cursor,0,1 FROM source_instances;
ALTER TABLE jobs RENAME TO legacy_jobs;
DROP INDEX IF EXISTS jobs_pending;
ALTER TABLE tasks RENAME TO legacy_tasks;
ALTER TABLE source_events RENAME TO legacy_source_events;
CREATE TABLE source_events (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instances(id), external_id TEXT NOT NULL,
 revision TEXT NOT NULL, occurred_at TEXT, received_at TEXT NOT NULL, role TEXT CHECK(role IN ('user','assistant','tool','system')),
 content TEXT NOT NULL, envelope TEXT NOT NULL CHECK(json_valid(envelope)), fingerprint TEXT NOT NULL, fingerprint_version INTEGER NOT NULL DEFAULT 1,
 scope_id TEXT NOT NULL, scope_epoch INTEGER NOT NULL, UNIQUE(source_id,external_id,revision));
CREATE TABLE source_object_heads (source_id TEXT NOT NULL REFERENCES source_instances(id), external_id TEXT NOT NULL,
 event_id INTEGER REFERENCES source_events(id), state TEXT NOT NULL CHECK(state IN ('current','tombstone','uncertain')),
 generation INTEGER NOT NULL CHECK(generation>0), PRIMARY KEY(source_id,external_id));
CREATE TABLE receipts (source_id TEXT NOT NULL, stream_id TEXT NOT NULL, scope_epoch INTEGER NOT NULL, batch_id TEXT NOT NULL,
 digest TEXT NOT NULL, inserted INTEGER NOT NULL, duplicates INTEGER NOT NULL, committed_version INTEGER NOT NULL, committed_at TEXT NOT NULL,
 PRIMARY KEY(source_id,stream_id,scope_epoch,batch_id), FOREIGN KEY(source_id,stream_id) REFERENCES source_streams(source_id,id));
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE identities (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instances(id), namespace TEXT NOT NULL, external_id TEXT NOT NULL,
 display_name TEXT NOT NULL, UNIQUE(source_id,namespace,external_id));
CREATE TABLE identity_mappings (id TEXT PRIMARY KEY, left_id TEXT NOT NULL REFERENCES identities(id), right_id TEXT NOT NULL REFERENCES identities(id),
 project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL CHECK(version>0), active INTEGER NOT NULL CHECK(active IN (0,1)), actor TEXT NOT NULL);
CREATE TABLE mapping_revisions (mapping_id TEXT NOT NULL REFERENCES identity_mappings(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(mapping_id,version));
CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT REFERENCES projects(id), intake TEXT CHECK(intake IN ('candidate','accepted','ignored')),
 status TEXT CHECK(status IN ('todo','in_progress','waiting','completed','cancelled')), evidence_status TEXT NOT NULL CHECK(evidence_status IN ('unknown','partial','sufficient','conflict')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), criteria_version INTEGER NOT NULL DEFAULT 0 CHECK(criteria_version>=0),
 manual_version INTEGER NOT NULL DEFAULT 0 CHECK(manual_version>=0), archived_at TEXT, legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)), updated_at TEXT NOT NULL,
 due_at TEXT, plan_effective_at TEXT, plan_event_id INTEGER REFERENCES source_events(id), deleted_at TEXT,
 CHECK(legacy=1 OR intake IS NOT NULL), CHECK(intake!='accepted' OR status IS NOT NULL));
CREATE TABLE task_baselines (task_id TEXT PRIMARY KEY REFERENCES tasks(id), snapshot TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'system_migration');
CREATE TABLE task_sources (task_id TEXT NOT NULL REFERENCES tasks(id), source_id TEXT NOT NULL REFERENCES source_instances(id), scope_id TEXT NOT NULL,
 PRIMARY KEY(task_id,source_id,scope_id));
CREATE INDEX task_source_scope ON task_sources(source_id,scope_id,task_id);
CREATE INDEX task_project_state ON tasks(project_id,intake,archived_at);
CREATE INDEX receipt_retention ON receipts(source_id,stream_id,committed_at,committed_version);
CREATE TABLE criterion_sets (task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL CHECK(version>0), PRIMARY KEY(task_id,version));
CREATE TABLE criteria (task_id TEXT NOT NULL, version INTEGER NOT NULL, id TEXT NOT NULL, description TEXT NOT NULL, origin_event_id INTEGER REFERENCES source_events(id),
 PRIMARY KEY(task_id,version,id), FOREIGN KEY(task_id,version) REFERENCES criterion_sets(task_id,version));
CREATE TABLE evidence_links (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, criteria_version INTEGER NOT NULL, criterion_id TEXT NOT NULL,
 event_id INTEGER NOT NULL REFERENCES source_events(id), relation TEXT NOT NULL CHECK(relation IN ('support','oppose','related')),
 validity TEXT NOT NULL CHECK(validity IN ('valid','invalid','needs_review')), start INTEGER NOT NULL CHECK(start>=0), end INTEGER NOT NULL CHECK(end>start),
 UNIQUE(task_id,criteria_version,criterion_id,event_id,relation,start,end), FOREIGN KEY(task_id,criteria_version,criterion_id) REFERENCES criteria(task_id,version,id));
CREATE TABLE operation_commits (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE decisions (id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operation_commits(id) DEFERRABLE INITIALLY DEFERRED,
 actor TEXT NOT NULL, reason TEXT NOT NULL, policy_version TEXT NOT NULL, input_refs TEXT NOT NULL, proposal TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE task_revisions (task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, decision_id INTEGER NOT NULL REFERENCES decisions(id), snapshot TEXT NOT NULL, PRIMARY KEY(task_id,version));
CREATE TABLE manual_overrides (task_id TEXT NOT NULL REFERENCES tasks(id), field TEXT NOT NULL, version INTEGER NOT NULL, decision_id INTEGER NOT NULL REFERENCES decisions(id), active INTEGER NOT NULL CHECK(active IN (0,1)), PRIMARY KEY(task_id,field));
CREATE TABLE notification_outbox (id TEXT PRIMARY KEY, decision_id INTEGER NOT NULL REFERENCES decisions(id), state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done')), created_at TEXT NOT NULL);
CREATE TABLE jobs (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES source_events(id), pipeline_version TEXT NOT NULL DEFAULT 'v1', run_generation INTEGER NOT NULL DEFAULT 0,
 operation_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry_wait','done','dead','paused','cancelled')),
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0), max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts>0),
 lease_owner TEXT, lease_token INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, next_run INTEGER NOT NULL DEFAULT 0, error_code TEXT,
 scope_epoch INTEGER NOT NULL, proposal TEXT, created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(event_id,pipeline_version,run_generation));
CREATE INDEX jobs_pending ON jobs(state,next_run);
CREATE TABLE job_attempts (job_id INTEGER NOT NULL REFERENCES jobs(id), token INTEGER NOT NULL, owner TEXT NOT NULL, started_at INTEGER NOT NULL, outcome TEXT, PRIMARY KEY(job_id,token));
CREATE TABLE search_documents (rowid INTEGER PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id), title TEXT NOT NULL, body TEXT NOT NULL, tokens TEXT NOT NULL, task_version INTEGER NOT NULL, tokenizer_version TEXT NOT NULL);
CREATE VIRTUAL TABLE task_fts USING fts5(title,tokens,content='search_documents',content_rowid='rowid',tokenize='unicode61');
CREATE TRIGGER search_ai AFTER INSERT ON search_documents BEGIN INSERT INTO task_fts(rowid,title,tokens) VALUES(new.rowid,new.title,new.tokens); END;
CREATE TRIGGER search_ad AFTER DELETE ON search_documents BEGIN INSERT INTO task_fts(task_fts,rowid,title,tokens) VALUES('delete',old.rowid,old.title,old.tokens); END;
CREATE TRIGGER search_au AFTER UPDATE ON search_documents BEGIN
 INSERT INTO task_fts(task_fts,rowid,title,tokens) VALUES('delete',old.rowid,old.title,old.tokens);
 INSERT INTO task_fts(rowid,title,tokens) VALUES(new.rowid,new.title,new.tokens); END;
CREATE TABLE search_identifiers (task_id TEXT NOT NULL REFERENCES tasks(id), value TEXT NOT NULL, PRIMARY KEY(task_id,value));
CREATE INDEX identifier_value ON search_identifiers(value,task_id);
CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO store_meta VALUES('search_ready','0');
`

export function migrate(
  db: Database.Database,
  path: string,
  fault: (point: string) => void,
  now: () => number,
): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > DATABASE_VERSION) throw new Error('DATABASE_TOO_NEW')
  if (version === DATABASE_VERSION) return
  if (version > 0) {
    fault('backup:before')
    const folder = join(dirname(path), basename(path) + '.backups')
    mkdirSync(folder, { recursive: true })
    const fs = statfsSync(dirname(path))
    if (fs.bavail * fs.bsize < statSync(path).size * 3 + 1024 * 1024)
      throw new Error('BACKUP_SPACE_REQUIRED')
    const backup = join(
      folder,
      'v' + version + '-' + now() + '-' + randomUUID() + '.sqlite',
    )
    if (existsSync(backup)) throw new Error('BACKUP_ALREADY_EXISTS')
    try {
      db.prepare('VACUUM INTO ?').run(backup)
      const saved = new Database(backup, { readonly: true })
      try {
        if (saved.pragma('quick_check', { simple: true }) !== 'ok')
          throw new Error('BACKUP_INVALID')
      } finally {
        saved.close()
      }
    } catch (error) {
      rmSync(backup, { force: true })
      throw error
    }
    fault('backup:after')
  }
  db.transaction(() => {
    if (version === 0) db.exec(v1)
    fault('migration:before')
    db.exec(v2)
    const events = db
      .prepare('SELECT * FROM legacy_source_events')
      .all() as Array<{
      id: number
      source_id: string
      external_id: string
      revision: string
      occurred_at: string
      received_at: string
      role: SourceEvent['role']
      content: string
    }>
    for (const row of events) {
      const envelope = upgradeLegacy({
        schemaVersion: 1,
        sourceInstanceId: row.source_id,
        externalId: row.external_id,
        revision: row.revision,
        occurredAt: row.occurred_at,
        role: row.role,
        text: row.content,
      })
      db.prepare(
        'INSERT INTO source_events(id,source_id,external_id,revision,occurred_at,received_at,role,content,envelope,fingerprint,scope_id,scope_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        row.id,
        row.source_id,
        row.external_id,
        row.revision,
        row.occurred_at,
        row.received_at,
        row.role,
        row.content,
        JSON.stringify(envelope),
        digest(factIdentity(envelope)),
        'legacy',
        1,
      )
      db.prepare(
        "INSERT INTO source_object_heads VALUES(?,?,?,'uncertain',1) ON CONFLICT(source_id,external_id) DO UPDATE SET event_id=NULL",
      ).run(row.source_id, row.external_id, row.id)
    }
    db.exec(`INSERT INTO jobs(id,event_id,operation_id,state,attempt,scope_epoch,created_at,error_code)
      SELECT id,event_id,'legacy-job:'||id,CASE state WHEN 'done' THEN 'done' WHEN 'failed' THEN 'dead' ELSE 'paused' END,attempt,1,'1970-01-01T00:00:00.000Z',COALESCE(error_code,'LEGACY_UNVERIFIED') FROM legacy_jobs;`)
    const tasks = db.prepare('SELECT * FROM legacy_tasks').all() as Array<{
      id: string
      title: string
      status: string
      evidence_status: string
      version: number
      archived_at: string | null
    }>
    for (const t of tasks) {
      db.prepare(
        "INSERT INTO tasks(id,title,intake,status,evidence_status,version,archived_at,legacy,updated_at) VALUES(?,?,NULL,?,'unknown',?,?,1,?)",
      ).run(
        t.id,
        t.title,
        t.status,
        t.version,
        t.archived_at,
        new Date(now()).toISOString(),
      )
      db.prepare(
        'INSERT INTO task_baselines(task_id,snapshot) VALUES(?,?)',
      ).run(t.id, JSON.stringify(t))
    }
    fault('migration:copied')
    db.exec(
      'DROP TABLE legacy_jobs; DROP TABLE legacy_source_events; DROP TABLE legacy_tasks;',
    )
    if ((db.pragma('foreign_key_check') as unknown[]).length)
      throw new Error('MIGRATION_FOREIGN_KEY_FAILED')
    fault('migration:verified')
    db.pragma('user_version = 2')
  }).immediate()
}

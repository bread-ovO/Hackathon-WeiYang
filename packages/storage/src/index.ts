import { createFeishu, migrateFeishu } from './feishu'
export type {
  FeishuConnection,
  FeishuAuthorized,
  FeishuAuthorizeInput,
  FeishuBatchInput,
  FeishuFailureInput,
  FeishuFailureCode,
  FeishuFence,
} from './feishu'
export { feishuFailureCodes } from './feishu'
import { createGithub, migrateGithub } from './github'
export type {
  GithubConnection,
  GithubAuthorized,
  GithubAuthorizeInput,
  GithubBatchInput,
  GithubFailureInput,
  GithubFailureCode,
} from './github'
export { githubFailureCodes } from './github'
import { createRevisionReview, migrateRevisionReview } from './revision-review'
import { createRetractions, migrateRetractions } from './retractions'
import {
  createIngestionBudget,
  migrateIngestionBudget,
} from './ingestion-budget'
import { createProcessing, migrateProcessing } from './processing'
export type { ProcessingContext, ProcessingResult } from './processing'
import { createEventReceiver } from './receive'
import { createEventContexts, migrateEventContexts } from './event-context'
export type { StoredEventContext } from './event-context'
import Database from 'better-sqlite3'
import { createPlugins, migratePlugins } from './plugins'
export type {
  HostPlugin,
  SafePlugin,
  PluginGrant,
  PluginActivation,
} from './plugins'
import { createExports } from './export'
export type { ExportBundle, ExportScope } from './export'
export { EXPORT_MAX_BYTES } from './export'
import { createSources, migrateSources } from './sources'
export type {
  SourceSummary,
  AuthorizedSource,
  SourceImportErrorCode,
} from './sources'
export { sourceImportErrorCodes } from './sources'
import {
  createTaskModel,
  migrateTaskModel,
  migrateTaskEditing,
} from './task-model'
export type {
  StoredTask,
  StoredTaskStatus,
  StoredAdmission,
  ManualActor,
  TaskExpectation,
  CriterionInput,
  EvidenceInput,
  TaskPatch,
  TaskPageQuery,
  TaskPage,
  TaskDecisionSummary,
} from './task-model'
import { createJobQueue } from './jobs'
import { createCandidateSearch, migrateSearch } from './search'
export type { SearchProjection, CandidateQuery, CandidateHit } from './search'
export type { Job, JobLease, JobErrorCode } from './jobs'
export { MAX_JOB_ATTEMPTS, JOB_LEASE_MS } from './jobs'
import type { SourceEvent, Health } from '@memo/contracts'

export function openStore(path: string) {
  const db = new Database(path)
  try {
    // The opt-in foundation store uses a different v2 schema. Never migrate it as production.
    if ((db.pragma('table_info(source_events)') as { name: string }[]).some(column => column.name === 'envelope'))
      throw new Error('INCOMPATIBLE_DATABASE_FORMAT')
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.pragma('busy_timeout = 3000')
    const version = db.pragma('user_version', { simple: true }) as number
    if (version > 13) throw new Error('DATABASE_TOO_NEW')
    if (version < 1)
      db.transaction(() => {
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
    if (version < 7) migrateEventContexts(db)
    if (version < 8) migrateProcessing(db)
    if (version < 9) migrateIngestionBudget(db)
    if (version < 10) migrateRetractions(db)
    if (version < 11) migrateRevisionReview(db)
    if (version < 12) migrateGithub(db)
    if (version < 13) migrateFeishu(db)
    const revisionReview = createRevisionReview(db)
    const retractions = createRetractions(db)
    const ingestion = createIngestionBudget(db)
    const contexts = createEventContexts(db)
    const receive = createEventReceiver(
      db,
      contexts.record,
      ingestion.assertCanReceive,
    )
    const observeEvent = (projectId: string, eventId: number) => {
      retractions.observe(projectId, eventId)
      revisionReview.observe(projectId, eventId)
    }
    const sources = createSources(db, receive, observeEvent)
    const plugins = createPlugins(db, receive, observeEvent)
    const github = createGithub(db, receive, observeEvent)
    const feishu = createFeishu(db, receive, observeEvent)
    return {
      feishu: {
        ...feishu,
        receiveBatch: (input: Parameters<typeof feishu.receiveBatch>[0]) =>
          ingestion.withBatch(() => feishu.receiveBatch(input)),
      },
      github: {
        ...github,
        receiveBatch: (input: Parameters<typeof github.receiveBatch>[0]) =>
          ingestion.withBatch(() => github.receiveBatch(input)),
      },
      ingestion,
      revisionReview,
      processing: createProcessing(db),
      contexts: { get: contexts.get },
      plugins: {
        ...plugins,
        receiveBatch: (...args: Parameters<typeof plugins.receiveBatch>) =>
          ingestion.withBatch(() => plugins.receiveBatch(...args)),
      },
      exports: createExports(db),
      sources: {
        ...sources,
        receiveBatch: (...args: Parameters<typeof sources.receiveBatch>) =>
          ingestion.withBatch(() => sources.receiveBatch(...args)),
      },
      tasks: createTaskModel(db),
      jobs: createJobQueue(db),
      search: createCandidateSearch(db),
      registerSource(id: string) {
        db.prepare(
          'INSERT INTO source_instances(id) VALUES (?) ON CONFLICT DO NOTHING',
        ).run(id)
      },
      receive(event: SourceEvent, cursor: string) {
        if (
          db
            .prepare('SELECT 1 FROM source_grants WHERE source_id=?')
            .get(event.sourceInstanceId) ||
          db
            .prepare(
              'SELECT 1 FROM plugin_source_history WHERE source_instance_id=?',
            )
            .get(event.sourceInstanceId) ||
          db
            .prepare('SELECT 1 FROM github_connections WHERE source_id=?')
            .get(event.sourceInstanceId) ||
          db
            .prepare('SELECT 1 FROM feishu_connections WHERE source_id=?')
            .get(event.sourceInstanceId)
        )
          throw new Error('USE_AUTHORIZED_SOURCE_BATCH')
        return ingestion.withBatch(() => receive(event, cursor))
      },
      health(): Health {
        return {
          status: 'ready',
          schemaVersion: db.pragma('user_version', { simple: true }) as number,
          sqliteVersion: (
            db.prepare('SELECT sqlite_version() AS version').get() as {
              version: string
            }
          ).version,
          eventCount: (
            db.prepare('SELECT COUNT(*) AS count FROM source_events').get() as {
              count: number
            }
          ).count,
          jobCount: (
            db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
              count: number
            }
          ).count,
        }
      },
      cursor(id: string) {
        return (
          db
            .prepare('SELECT cursor FROM source_instances WHERE id=?')
            .get(id) as { cursor: string } | undefined
        )?.cursor
      },
      close() {
        db.close()
      },
    }
  } catch (error) {
    db.close()
    throw error
  }
}

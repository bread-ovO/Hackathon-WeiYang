import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  parseTaskAnalysis,
  type AnalysisMessage,
  type TaskAnalysis,
} from '@memo/contracts'
import { createTaskModel } from './task-model'
import { createAnalysisContext } from './task-analysis-context'

export function migrateTaskAnalysis(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE model_analyses (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instances(id),
      project_id TEXT NOT NULL REFERENCES projects(id), grant_version INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, model TEXT NOT NULL, protocol TEXT NOT NULL,
      messages TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(source_id,fingerprint,model,protocol)
    );
    CREATE TABLE model_analysis_acceptances (
      run_id TEXT NOT NULL REFERENCES model_analyses(id), candidate_index INTEGER NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id), anchor TEXT NOT NULL, PRIMARY KEY(run_id,candidate_index)
    ); PRAGMA user_version=23;`)
  })()
}
export function createTaskAnalysis(db: Database.Database) {
  const context = createAnalysisContext(db)
  const api = {
    context,
    pending(protocol: string) {
      // Bound background provider spend across restarts; unchanged content is cached below.
      const recent = db
        .prepare('SELECT count(*) AS n FROM model_analyses WHERE created_at>=?')
        .get(new Date(Date.now() - 3600_000).toISOString()) as { n: number }
      if (recent.n >= 12) return []
      const ids = db
        .prepare(
          `SELECT source_id AS id FROM source_grants WHERE revoked=0 AND error_code IS NULL
        UNION SELECT source_id AS id FROM feishu_connections WHERE revoked=0 AND enabled=1
        UNION SELECT source_instance_id AS id FROM plugin_bindings WHERE enabled=1 AND uninstalled=0 AND has_error=0`,
        )
        .all() as { id: string }[]
      return ids.flatMap(({ id }) => {
        let afterEventId = 0
        // A bounded scan of cached windows; unprocessed content remains pending.
        for (let page = 0; page < 1024; page++) {
          try {
            const cached = db
              .prepare(
                `SELECT a.fingerprint,w.end_event_id FROM model_analyses a JOIN model_analysis_windows w ON w.run_id=a.id WHERE a.source_id=? AND a.protocol=? AND w.after_event_id=? ORDER BY w.end_event_id DESC`,
              )
              .all(id, protocol, afterEventId) as {
              fingerprint: string
              end_event_id: number
            }[]
            const done = cached.find((row) => {
              try {
                return (
                  context(id, afterEventId, protocol, row.end_event_id)
                    .fingerprint === row.fingerprint
                )
              } catch {
                return false
              }
            })
            if (done) {
              const prior = context(
                id,
                afterEventId,
                protocol,
                done.end_event_id,
              )
              if (!prior.hasMore) return []
              afterEventId = done.end_event_id
              continue
            }
            const input = context(id, afterEventId, protocol)
            return [
              { sourceId: id, fingerprint: input.fingerprint, afterEventId },
            ]
          } catch (error) {
            // Empty or revoked sources have no work; malformed/oversized input
            // must reach the service so the user sees an actionable error.
            if (
              error instanceof Error &&
              ['ANALYSIS_NO_CONTEXT', 'ANALYSIS_SOURCE_UNAVAILABLE'].includes(
                error.message,
              )
            )
              return []
            return [{ sourceId: id, fingerprint: '', afterEventId }]
          }
        }
        return []
      })
    },
    discover(
      input: ReturnType<typeof context>,
      result: TaskAnalysis,
      model: string,
      protocol: string,
    ): string {
      return db.transaction(() => {
        const runId = api.save(input, result, model, protocol)
        api
          .read(runId)
          .tasks.forEach((_, index) => api.accept(runId, index, true))
        return runId
      })()
    },
    read(runId: string) {
      const row = db
        .prepare('SELECT result,messages FROM model_analyses WHERE id=?')
        .get(runId) as { result: string; messages: string } | undefined
      if (!row) throw new Error('INVALID_TASK_ANALYSIS')
      return parseTaskAnalysis(JSON.parse(row.result), JSON.parse(row.messages))
    },
    forTask(projectId: string, taskId: string) {
      const row = db
        .prepare(
          `SELECT a.model,a.created_at,a.result,a.messages,c.candidate_index,a.source_id,
          COALESCE(g.display_name, '飞书 · ' || f.chat_id, a.source_id) AS source_name
          FROM model_analyses a JOIN model_analysis_acceptances c ON c.run_id=a.id
          LEFT JOIN source_grants g ON g.source_id=a.source_id LEFT JOIN feishu_connections f ON f.source_id=a.source_id WHERE a.project_id=? AND c.task_id=? ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`,
        )
        .get(projectId, taskId) as
        | {
            source_id: string
            source_name: string
            model: string
            created_at: string
            result: string
            messages: string
            candidate_index: number
          }
        | undefined
      if (!row) return null
      try {
        const candidate = parseTaskAnalysis(
          JSON.parse(row.result),
          JSON.parse(row.messages),
        ).tasks[row.candidate_index]
        return candidate
          ? {
              model: row.model,
              createdAt: row.created_at,
              sourceId: row.source_id,
              sourceName: row.source_name,
              candidate,
            }
          : null
      } catch {
        return null
      }
    },
    latest(protocol: string) {
      const row = db
        .prepare(
          `SELECT a.id,a.source_id,a.result,a.messages,a.model FROM model_analyses a WHERE a.protocol=? AND (EXISTS(SELECT 1 FROM source_grants g WHERE g.source_id=a.source_id AND g.revoked=0) OR EXISTS(SELECT 1 FROM feishu_connections f WHERE f.source_id=a.source_id AND f.revoked=0 AND f.enabled=1)) ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`,
        )
        .get(protocol) as
        | {
            id: string
            source_id: string
            result: string
            messages: string
            model: string
          }
        | undefined
      if (!row) return null
      try {
        return {
          runId: row.id,
          model: row.model,
          sourceId: row.source_id,
          result: parseTaskAnalysis(
            JSON.parse(row.result),
            JSON.parse(row.messages),
          ),
          messageCount: (JSON.parse(row.messages) as unknown[]).length,
        }
      } catch {
        return null
      }
    },
    save: db.transaction(
      (
        input: ReturnType<typeof context>,
        result: TaskAnalysis,
        model: string,
        protocol: string,
      ) => {
        const current = context(
          input.sourceId,
          input.afterEventId,
          protocol,
          input.endEventId,
        )
        if (current.fingerprint !== input.fingerprint)
          throw new Error('ANALYSIS_CONTEXT_CHANGED')
        const safe = parseTaskAnalysis(result, current.messages)
        const used = new Set<string>()
        for (const task of safe.tasks) {
          if (!task.existingTaskId) continue
          const existing = current.knownTasks.find(
            (t) => t.id === task.existingTaskId,
          )
          const originalRequest = current.messages
            .filter((m) => m.role === 'user')
            .flatMap(
              (m) =>
                existing?.evidence.filter((e) => e.messageId === m.id) ?? [],
            )[0]
          if (
            !existing ||
            !originalRequest ||
            used.has(existing.id) ||
            !task.evidence.some(
              (e) => e.messageId === originalRequest.messageId,
            )
          )
            throw new Error('INVALID_TASK_ANALYSIS')
          used.add(existing.id)
        }
        const id = randomUUID()
        db.prepare(
          'INSERT OR IGNORE INTO model_analyses VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          input.sourceId,
          current.projectId,
          current.grantVersion,
          input.fingerprint,
          model,
          protocol,
          JSON.stringify(current.messages),
          JSON.stringify(safe),
          new Date().toISOString(),
        )
        const saved = (
          db
            .prepare(
              'SELECT id FROM model_analyses WHERE source_id=? AND fingerprint=? AND model=? AND protocol=?',
            )
            .get(input.sourceId, input.fingerprint, model, protocol) as {
            id: string
          }
        ).id
        db.prepare(
          'INSERT OR IGNORE INTO model_analysis_windows VALUES(?,?,?)',
        ).run(saved, current.afterEventId, current.endEventId)
        return saved
      },
    ),
    accepted(runId: string) {
      return (
        db
          .prepare(
            'SELECT candidate_index AS idx FROM model_analysis_acceptances WHERE run_id=?',
          )
          .all(runId) as { idx: number }[]
      ).map((r) => r.idx)
    },
    accept: db.transaction(
      (runId: string, index: number, automatic = false) => {
        const row = db
          .prepare(
            'SELECT a.*,COALESCE(w.after_event_id,0) AS after_event_id, w.end_event_id FROM model_analyses a LEFT JOIN model_analysis_windows w ON w.run_id=a.id WHERE a.id=?',
          )
          .get(runId) as
          | {
              source_id: string
              project_id: string
              fingerprint: string
              messages: string
              result: string
              model: string
              protocol: string
              after_event_id: number
              end_event_id: number | null
            }
          | undefined
        if (
          !row ||
          context(
            row.source_id,
            row.after_event_id,
            row.protocol,
            row.end_event_id ?? Number.MAX_SAFE_INTEGER,
          ).fingerprint !== row.fingerprint
        )
          throw new Error('ANALYSIS_CONTEXT_CHANGED')
        if (
          db
            .prepare(
              'SELECT 1 FROM model_analysis_acceptances WHERE run_id=? AND candidate_index=?',
            )
            .get(runId, index)
        )
          return
        const result = parseTaskAnalysis(
          JSON.parse(row.result),
          JSON.parse(row.messages),
        )
        const candidate = result.tasks[index]
        if (!candidate) throw new Error('INVALID_TASK_ANALYSIS')
        const messages = JSON.parse(row.messages) as AnalysisMessage[]
        const request = messages
          .filter((m) => m.role === 'user')
          .flatMap((m) =>
            candidate.evidence.filter((e) => e.messageId === m.id),
          )[0]!
        const anchor = createHash('sha256')
          .update(
            JSON.stringify([
              row.project_id,
              row.source_id,
              request.messageId,
              candidate.title.trim().normalize('NFKC'),
            ]),
          )
          .digest('hex')
        const prior = candidate.existingTaskId
          ? { task_id: candidate.existingTaskId }
          : (db
              .prepare(
                'SELECT task_id FROM model_analysis_acceptances WHERE anchor=? LIMIT 1',
              )
              .get(anchor) as { task_id: string } | undefined)
        if (prior) {
          db.prepare(
            'INSERT INTO model_analysis_acceptances VALUES(?,?,?,?)',
          ).run(runId, index, prior.task_id, anchor)
          return
        }
        const taskId = randomUUID()
        createTaskModel(db).create(
          {
            id: taskId,
            projectId: row.project_id,
            title: candidate.title,
            admission: automatic ? 'candidate' : 'accepted',
          },
          {
            actorId: automatic ? 'ai-organizer' : 'local-user',
            reason: `${automatic ? '后台整理为待确认事项：' : '用户确认'}大模型建议（${row.model}，分析 ${runId}）。阶段建议 ${candidate.stage} 未自动修改业务状态。`,
          },
        )
        db.prepare(
          'INSERT INTO model_analysis_acceptances VALUES(?,?,?,?)',
        ).run(runId, index, taskId, anchor)
      },
    ),
  }
  return api
}

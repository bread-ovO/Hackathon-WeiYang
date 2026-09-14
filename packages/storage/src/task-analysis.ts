import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  parseTaskAnalysis,
  type AnalysisMessage,
  type TaskAnalysis,
} from '@memo/contracts'
import { createTaskModel } from './task-model'

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
  function context(sourceId: string) {
    const grant = db
      .prepare(
        `SELECT project_id AS projectId,grant_version AS grantVersion FROM source_grants WHERE source_id=? AND revoked=0
         UNION ALL SELECT project_id AS projectId,grant_version AS grantVersion FROM feishu_connections WHERE source_id=? AND revoked=0 AND enabled=1`,
      )
      .get(sourceId, sourceId) as { projectId: string; grantVersion: number } | undefined
    if (!grant) throw new Error('ANALYSIS_SOURCE_UNAVAILABLE')
    const rows = db
      .prepare(
        `SELECT e.id,e.role,e.content FROM source_events e
      JOIN event_projects p ON p.event_id=e.id AND p.project_id=?
      WHERE e.source_id=? AND e.role IN ('user','assistant') AND COALESCE(e.operation,'upsert')!='retract'
      AND NOT EXISTS(SELECT 1 FROM source_events newer WHERE newer.source_id=e.source_id AND newer.external_id=e.external_id AND newer.id>e.id)
      ORDER BY e.id DESC LIMIT 65`,
      )
      .all(grant.projectId, sourceId) as {
      id: number
      role: 'user' | 'assistant'
      content: string
    }[]
    const messages: AnalysisMessage[] = []
    let length = 0
    for (const r of rows) {
      if (messages.length === 64 || length + r.content.length > 24000) break
      length += r.content.length
      messages.unshift({ id: `e${r.id}`, role: r.role, text: r.content })
    }
    if (!messages.length) throw new Error('ANALYSIS_NO_CONTEXT')
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([grant, messages]))
      .digest('hex')
    return {
      ...grant,
      sourceId,
      messages,
      fingerprint,
      truncated: rows.length > messages.length,
    }
  }
  const api = {
    context,
    pending(protocol: string) {
      // Bound background provider spend across restarts; unchanged content is cached below.
      const recent = db.prepare('SELECT count(*) AS n FROM model_analyses WHERE created_at>=?').get(new Date(Date.now()-3600_000).toISOString()) as {n:number}
      if (recent.n >= 12) return []
      const ids = db.prepare(`SELECT source_id AS id FROM source_grants WHERE revoked=0
        UNION SELECT source_id AS id FROM feishu_connections WHERE revoked=0 AND enabled=1`).all() as {id:string}[]
      return ids.flatMap(({id}) => {
        try {
          const input = context(id)
          const done = db.prepare('SELECT 1 FROM model_analyses WHERE source_id=? AND fingerprint=? AND protocol=?').get(id,input.fingerprint,protocol)
          return done ? [] : [{sourceId:id, fingerprint:input.fingerprint}]
        } catch { return [] }
      })
    },
    discover(input: ReturnType<typeof context>, result: TaskAnalysis, model: string, protocol: string): string {
      return db.transaction(() => {
        const runId = api.save(input, result, model, protocol)
        result.tasks.forEach((_, index) => api.accept(runId, index, true))
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
          LEFT JOIN source_grants g ON g.source_id=a.source_id LEFT JOIN feishu_connections f ON f.source_id=a.source_id WHERE a.project_id=? AND c.task_id=? ORDER BY a.created_at DESC LIMIT 1`,
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
          ? { model: row.model, createdAt: row.created_at, sourceId: row.source_id, sourceName: row.source_name, candidate }
          : null
      } catch {
        return null
      }
    },
    latest(protocol: string) {
      const row = db
        .prepare(
          `SELECT a.id,a.source_id,a.result,a.messages,a.model FROM model_analyses a WHERE a.protocol=? AND (EXISTS(SELECT 1 FROM source_grants g WHERE g.source_id=a.source_id AND g.revoked=0) OR EXISTS(SELECT 1 FROM feishu_connections f WHERE f.source_id=a.source_id AND f.revoked=0 AND f.enabled=1)) ORDER BY a.created_at DESC LIMIT 1`,
        )
        .get(protocol) as
        | { id: string; source_id: string; result: string; messages: string; model: string }
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
    save(
      input: ReturnType<typeof context>,
      result: TaskAnalysis,
      model: string,
      protocol: string,
    ) {
      const current = context(input.sourceId)
      if (current.fingerprint !== input.fingerprint)
        throw new Error('ANALYSIS_CONTEXT_CHANGED')
      const safe = parseTaskAnalysis(result, current.messages)
      const id = randomUUID()
      db.prepare(
        'INSERT OR IGNORE INTO model_analyses VALUES(?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        input.sourceId,
        input.projectId,
        input.grantVersion,
        input.fingerprint,
        model,
        protocol,
        JSON.stringify(input.messages),
        JSON.stringify(safe),
        new Date().toISOString(),
      )
      return (
        db
          .prepare(
            'SELECT id FROM model_analyses WHERE source_id=? AND fingerprint=? AND model=? AND protocol=?',
          )
          .get(input.sourceId, input.fingerprint, model, protocol) as {
          id: string
        }
      ).id
    },
    accepted(runId: string) {
      return (
        db
          .prepare(
            'SELECT candidate_index AS idx FROM model_analysis_acceptances WHERE run_id=?',
          )
          .all(runId) as { idx: number }[]
      ).map((r) => r.idx)
    },
    accept: db.transaction((runId: string, index: number, automatic = false) => {
      const row = db
        .prepare('SELECT * FROM model_analyses WHERE id=?')
        .get(runId) as
        | {
            source_id: string
            project_id: string
            fingerprint: string
            messages: string
            result: string
            model: string
          }
        | undefined
      if (!row || context(row.source_id).fingerprint !== row.fingerprint)
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
        .update(JSON.stringify([row.project_id, row.source_id, request, candidate.title.trim()]))
        .digest('hex')
      const prior = db
        .prepare(
          'SELECT task_id FROM model_analysis_acceptances WHERE anchor=? LIMIT 1',
        )
        .get(anchor) as { task_id: string } | undefined
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
      db.prepare('INSERT INTO model_analysis_acceptances VALUES(?,?,?,?)').run(
        runId,
        index,
        taskId,
        anchor,
      )
    }),
  }
  return api
}

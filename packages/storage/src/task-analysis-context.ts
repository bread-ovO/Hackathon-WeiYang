import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  parseTaskAnalysis,
  TASK_ANALYSIS_PROTOCOL,
  type AnalysisMessage,
  type KnownAnalysisTask,
} from '@memo/contracts'

export function migrateAnalysisWindows(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
    CREATE TABLE model_analysis_windows (
      run_id TEXT PRIMARY KEY REFERENCES model_analyses(id),
      after_event_id INTEGER NOT NULL,
      end_event_id INTEGER NOT NULL
    );
    CREATE INDEX model_analysis_windows_end ON model_analysis_windows(end_event_id);
    PRAGMA user_version=25;
  `),
  )()
}

const eligible = `e.source_id=? AND e.role IN ('user','assistant')
  AND COALESCE(e.operation,'upsert')!='retract'
  AND EXISTS(SELECT 1 FROM event_projects p WHERE p.event_id=e.id AND p.project_id=?)
  AND NOT EXISTS(SELECT 1 FROM source_events newer WHERE newer.source_id=e.source_id AND newer.external_id=e.external_id AND newer.id>e.id)`
type Row = { id: number; role: 'user' | 'assistant'; content: string }
const asMessage = (r: Row): AnalysisMessage => ({
  id: `e${r.id}`,
  role: r.role,
  text: r.content,
})

/** Pages in ingestion order; never discards the front of a conversation. The
 * window and source-backed task memory are fingerprinted before inference. */
export function createAnalysisContext(db: Database.Database) {
  return function context(
    sourceId: string,
    afterEventId = 0,
    protocol = TASK_ANALYSIS_PROTOCOL,
    throughEventId = Number.MAX_SAFE_INTEGER,
  ) {
    if (
      !Number.isSafeInteger(afterEventId) ||
      afterEventId < 0 ||
      !Number.isSafeInteger(throughEventId) ||
      throughEventId <= afterEventId
    )
      throw new Error('INVALID_TASK_ANALYSIS')
    const grant = db
      .prepare(
        `
      SELECT project_id AS projectId,grant_version AS grantVersion FROM source_grants WHERE source_id=? AND revoked=0 AND error_code IS NULL
      UNION ALL SELECT project_id AS projectId,grant_version AS grantVersion FROM feishu_connections WHERE source_id=? AND revoked=0 AND enabled=1
      UNION ALL SELECT project_id AS projectId,grant_version AS grantVersion FROM plugin_bindings WHERE source_instance_id=? AND enabled=1 AND uninstalled=0 AND has_error=0
    `,
      )
      .get(sourceId, sourceId, sourceId) as
      | { projectId: string; grantVersion: number }
      | undefined
    if (!grant) throw new Error('ANALYSIS_SOURCE_UNAVAILABLE')
    const rows = db
      .prepare(
        `SELECT e.id,e.role,e.content FROM source_events e WHERE ${eligible} AND e.id>? AND e.id<=? ORDER BY e.id LIMIT 49`,
      )
      .all(sourceId, grant.projectId, afterEventId, throughEventId) as Row[]
    const selected: Row[] = []
    let length = 0
    for (const row of rows) {
      if (selected.length === 48 || length + row.content.length > 24000) break
      selected.push(row)
      length += row.content.length
    }
    if (!selected.length)
      throw new Error(
        rows.length ? 'ANALYSIS_MESSAGE_TOO_LARGE' : 'ANALYSIS_NO_CONTEXT',
      )
    const endEventId = selected.at(-1)!.id
    const selectedMessages = new Map(
      selected.map((r) => [`e${r.id}`, asMessage(r)]),
    )
    const knownTasks: KnownAnalysisTask[] = []
    let memoryTruncated = false
    const history = db
      .prepare(
        `
      SELECT c.task_id,t.title,a.result,a.messages,c.candidate_index
      FROM model_analysis_acceptances c
      JOIN model_analyses a ON a.id=c.run_id
      JOIN model_analysis_windows w ON w.run_id=a.id
      JOIN tasks t ON t.id=c.task_id AND t.project_id=a.project_id
      WHERE a.source_id=? AND a.project_id=? AND a.protocol=? AND w.end_event_id<=?
      AND NOT EXISTS(SELECT 1 FROM agent_task_trash trash WHERE trash.task_id=t.id)
      ORDER BY w.end_event_id DESC,a.created_at DESC,a.rowid DESC LIMIT 128
    `,
      )
      .all(sourceId, grant.projectId, protocol, afterEventId) as {
      task_id: string
      title: string
      result: string
      messages: string
      candidate_index: number
    }[]
    const seen = new Set<string>()
    for (const row of history) {
      if (seen.has(row.task_id)) continue
      seen.add(row.task_id)
      if (knownTasks.length === 12) {
        memoryTruncated = true
        break
      }
      try {
        const priorMessages = JSON.parse(row.messages) as AnalysisMessage[]
        const task = parseTaskAnalysis(JSON.parse(row.result), priorMessages)
          .tasks[row.candidate_index]
        if (!task) continue
        const refs = [...new Set(task.evidence.map((e) => e.messageId))]
        const originals = refs.map(
          (id) =>
            db
              .prepare(
                `SELECT e.id,e.role,e.content FROM source_events e WHERE ${eligible} AND e.id=?`,
              )
              .get(sourceId, grant.projectId, Number(id.slice(1))) as
              | Row
              | undefined,
        )
        if (originals.some((r) => !r)) {
          memoryTruncated = true
          continue
        }
        const extra = originals.filter(
          (r): r is Row => !!r && !selectedMessages.has(`e${r.id}`),
        )
        const extraLength = extra.reduce((n, r) => n + r.content.length, 0)
        if (
          selectedMessages.size + extra.length > 64 ||
          length + extraLength > 65536
        ) {
          memoryTruncated = true
          continue
        }
        extra.forEach((r) => selectedMessages.set(`e${r.id}`, asMessage(r)))
        length += extraLength
        knownTasks.push({
          id: row.task_id,
          title: row.title,
          stage: task.stage,
          nextAction: task.nextAction,
          evidence: task.evidence,
        })
      } catch {
        memoryTruncated = true
      }
    }
    // A nearby unadopted assistant suggestion may become actionable in this page.
    const preceding = db
      .prepare(
        `SELECT e.id,e.role,e.content FROM source_events e WHERE ${eligible} AND e.id<=? ORDER BY e.id DESC LIMIT 8`,
      )
      .all(sourceId, grant.projectId, afterEventId) as Row[]
    for (const r of preceding) {
      if (selectedMessages.has(`e${r.id}`)) continue
      if (selectedMessages.size === 64 || length + r.content.length > 65536)
        break
      selectedMessages.set(`e${r.id}`, asMessage(r))
      length += r.content.length
    }
    const messages = [...selectedMessages.values()].sort(
      (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)),
    )
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([grant, afterEventId, messages, knownTasks]))
      .digest('hex')
    return {
      ...grant,
      sourceId,
      afterEventId,
      endEventId,
      messages,
      knownTasks,
      fingerprint,
      hasMore: !!db
        .prepare(
          `SELECT 1 FROM source_events e WHERE ${eligible} AND e.id>? LIMIT 1`,
        )
        .get(sourceId, grant.projectId, endEventId),
      truncated: memoryTruncated,
      newMessageCount: selected.length,
    }
  }
}

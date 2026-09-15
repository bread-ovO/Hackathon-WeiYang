import type Database from 'better-sqlite3'

// UNION also bounds malformed cycles; only project-local, persisted merge edges count.
export const taskAncestors = `WITH RECURSIVE lineage(id) AS (
  SELECT id FROM tasks WHERE id=@taskId AND project_id=@projectId
  UNION SELECT m.source_id FROM task_merges m JOIN lineage l ON m.target_id=l.id
    WHERE m.project_id=@projectId
)`

export function canonicalTaskId(
  db: Database.Database,
  projectId: string,
  taskId: string,
): string {
  const row = db
    .prepare(
      `WITH RECURSIVE targets(id) AS (
    SELECT id FROM tasks WHERE id=? AND project_id=?
    UNION SELECT m.target_id FROM task_merges m JOIN targets t ON m.source_id=t.id
      WHERE m.project_id=?
  ) SELECT t.id FROM targets t WHERE NOT EXISTS (
    SELECT 1 FROM task_merges m WHERE m.source_id=t.id AND m.project_id=?
  )`,
    )
    .get(taskId, projectId, projectId, projectId) as
    | { id: string }
    | undefined
  if (!row) throw Error('TASK_NOT_IN_PROJECT')
  return row.id
}

export const modelSourceFilter = `EXISTS (
  WITH RECURSIVE lineage(id) AS (
    SELECT tasks.id UNION SELECT m.source_id FROM task_merges m JOIN lineage l ON m.target_id=l.id
    WHERE m.project_id=tasks.project_id
  ) SELECT 1 FROM model_analysis_acceptances c JOIN model_analyses a ON a.id=c.run_id
    WHERE c.task_id IN (SELECT id FROM lineage) AND a.project_id=tasks.project_id AND a.source_id=?
)`


export const modelActivity = `(WITH RECURSIVE lineage(id) AS (
  SELECT tasks.id UNION SELECT m.source_id FROM task_merges m JOIN lineage l ON m.target_id=l.id
  WHERE m.project_id=tasks.project_id
) SELECT max(a.created_at) FROM model_analysis_acceptances c JOIN model_analyses a ON a.id=c.run_id
  WHERE c.task_id IN (SELECT id FROM lineage) AND a.project_id=tasks.project_id)`

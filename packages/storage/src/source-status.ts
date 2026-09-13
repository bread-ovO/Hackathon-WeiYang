import type Database from 'better-sqlite3'
export type CurrentSourceStatus =
  | 'active'
  | 'paused'
  | 'revoked'
  | 'uninstalled'
  | 'unknown'
/** Current authorization state, independent from historical message/reference validity. */
export function getSourceStatus(
  db: Database.Database,
  projectId: string,
  sourceInstanceId: string,
): CurrentSourceStatus {
  if (
    [projectId, sourceInstanceId].some(
      (value) =>
        typeof value !== 'string' || !value.length || value.length > 256,
    )
  )
    throw Error('INVALID_SOURCE_STATUS')
  const rows = db
    .prepare(
      `
    SELECT CASE WHEN revoked=1 THEN 'revoked' WHEN revoked=0 THEN 'active' END AS status FROM source_grants WHERE project_id=@project AND source_id=@source
    UNION ALL SELECT CASE WHEN uninstalled=1 THEN 'uninstalled' WHEN enabled=0 THEN 'paused' WHEN enabled=1 AND uninstalled=0 THEN 'active' END FROM plugin_bindings WHERE project_id=@project AND source_instance_id=@source
    UNION ALL SELECT CASE WHEN revoked=1 THEN 'revoked' WHEN enabled=0 THEN 'paused' WHEN enabled=1 AND revoked=0 THEN 'active' END FROM github_connections WHERE project_id=@project AND source_id=@source
    UNION ALL SELECT CASE WHEN revoked=1 THEN 'revoked' WHEN enabled=0 THEN 'paused' WHEN enabled=1 AND revoked=0 THEN 'active' END FROM feishu_connections WHERE project_id=@project AND source_id=@source
    UNION ALL SELECT 'uninstalled' FROM plugin_source_history h WHERE h.source_instance_id=@source AND NOT EXISTS(SELECT 1 FROM plugin_bindings b WHERE b.source_instance_id=h.source_instance_id) AND EXISTS(SELECT 1 FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=@project AND e.source_id=h.source_instance_id)
  `,
    )
    .all({ project: projectId, source: sourceInstanceId }) as {
    status: unknown
  }[]
  if (!rows.length) return 'unknown'
  if (
    rows.length !== 1 ||
    !['active', 'paused', 'revoked', 'uninstalled'].includes(
      rows[0]!.status as string,
    )
  )
    throw Error('INVALID_SOURCE_STATUS')
  return rows[0]!.status as CurrentSourceStatus
}

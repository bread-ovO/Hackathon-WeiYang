import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
export type PluginGrant =
  | { kind: 'http-json'; domain: string; credentialId?: string }
  | { kind: 'local-jsonl'; path: string }
export interface SafePlugin {
  id: string
  projectId: string
  displayName: string
  version: string
  digest: string
  status: 'active' | 'disabled' | 'error'
  grantVersion: number
  eventCount: number
  lastSuccessAt: string | null
}
export interface HostPlugin extends SafePlugin {
  manifest: Record<string, unknown>
  grant: PluginGrant
  cursor: string
  sourceInstanceId: string
}
export interface PluginActivation {
  id: string
  projectId: string
  displayName: string
  version: string
  digest: string
  manifest: object
  grant: PluginGrant
}
const summary = `SELECT p.id,p.project_id AS projectId,p.display_name AS displayName,p.version,p.digest,
 CASE WHEN p.enabled=0 THEN 'disabled' WHEN p.has_error=1 THEN 'error' ELSE 'active' END AS status,
 p.grant_version AS grantVersion,p.last_success_at AS lastSuccessAt,
 (SELECT count(*) FROM source_events e WHERE e.source_id=p.source_instance_id) AS eventCount
 FROM plugin_bindings p`
function invalid(): never {
  throw new Error('PLUGIN_INVALID_DATA')
}
function text(v: unknown, max = 256): asserts v is string {
  if (
    typeof v !== 'string' ||
    !v.trim() ||
    v.length > max ||
    /[\u0000-\u001f\u007f]/.test(v)
  )
    invalid()
}
function integer(v: unknown): asserts v is number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) invalid()
}
function keys(
  value: unknown,
  allowed: string[],
  required: string[] = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(v, k))
  )
    invalid()
  return v
}
function manifestJson(value: object): string {
  // Host performs P01 semantic schema validation; storage prevents secret-bearing extension fields.
  const m = keys(value, [
    'id',
    'version',
    'schemaVersion',
    'sourceType',
    'displayName',
    'hostApiRange',
    'kind',
    'permissions',
    'transport',
    'sampling',
    'mapping',
  ])
  keys(m.hostApiRange, ['minInclusive', 'maxExclusive'])
  keys(m.sampling, ['intervalSeconds', 'maxRecordsPerRun'])
  const permissions = keys(m.permissions, [
    'domains',
    'directories',
    'credentials',
  ])
  for (const name of ['domains', 'directories', 'credentials'])
    if (!Array.isArray(permissions[name])) invalid()
  for (const row of permissions.directories as unknown[])
    keys(row, ['id', 'purpose'])
  for (const row of permissions.credentials as unknown[])
    keys(row, ['id', 'purpose'])
  const mapping = keys(m.mapping, [
    'externalId',
    'revision',
    'occurredAt',
    'role',
    'text',
  ])
  for (const [name, v] of Object.entries(mapping))
    keys(v, name === 'role' ? ['pointer', 'constant'] : ['pointer'], [])
  if (m.kind === 'http-json') {
    const transport = keys(
      m.transport,
      [
        'url',
        'method',
        'recordsPointer',
        'maxResponseBytes',
        'maxPages',
        'requestsPerMinute',
        'credentialId',
        'pagination',
      ],
      [
        'url',
        'method',
        'recordsPointer',
        'maxResponseBytes',
        'maxPages',
        'requestsPerMinute',
      ],
    )
    if (transport.pagination !== undefined)
      keys(transport.pagination, ['cursorPointer', 'cursorParameter'])
  } else if (m.kind === 'local-jsonl')
    keys(m.transport, ['directoryId', 'file', 'maxFileBytes', 'maxLineBytes'])
  else invalid()
  // Reject non-JSON values instead of stringify silently erasing functions or coercing NaN.
  const inspect = (v: unknown, depth: number): void => {
    if (depth > 12) invalid()
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (Array.isArray(v)) {
      v.forEach((x) => inspect(x, depth + 1))
      return
    }
    if (
      v &&
      typeof v === 'object' &&
      (Object.getPrototypeOf(v) === Object.prototype ||
        Object.getPrototypeOf(v) === null)
    ) {
      for (const child of Object.values(v)) inspect(child, depth + 1)
      return
    }
    invalid()
  }
  inspect(m, 0)
  let json: string
  try {
    json = JSON.stringify(m)
  } catch {
    invalid()
  }
  if (Buffer.byteLength(json) > 128 * 1024)
    throw new Error('PLUGIN_LIMIT_EXCEEDED')
  return json
}
function grantJson(
  value: PluginGrant,
  manifest: Record<string, unknown>,
): string {
  if (value?.kind === 'http-json') {
    const grant = keys(
      value,
      ['kind', 'domain', 'credentialId'],
      ['kind', 'domain'],
    )
    text(grant.domain, 253)
    if (grant.credentialId !== undefined) text(grant.credentialId)
    const permissions = manifest.permissions as {
      domains: string[]
      credentials: { id: string }[]
    }
    const transport = manifest.transport as {
      credentialId?: string
      url: string
    }
    if (
      manifest.kind !== value.kind ||
      permissions.domains.length !== 1 ||
      permissions.domains[0] !== grant.domain ||
      Boolean(transport.credentialId) !== Boolean(grant.credentialId)
    )
      invalid()
    let url: URL
    try {
      url = new URL(transport.url)
    } catch {
      invalid()
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== grant.domain ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.port && url.port !== '443')
    )
      invalid()
  } else if (value?.kind === 'local-jsonl') {
    const grant = keys(value, ['kind', 'path'])
    text(grant.path, 4096)
    if (
      manifest.kind !== value.kind ||
      !isAbsolute(grant.path) ||
      normalize(grant.path) !== grant.path
    )
      invalid()
  } else invalid()
  return JSON.stringify(value)
}
export function migratePlugins(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
 CREATE TABLE plugin_bindings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_instance_id TEXT NOT NULL UNIQUE REFERENCES source_instances(id),
 display_name TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,manifest_json TEXT NOT NULL,grant_json TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),has_error INTEGER NOT NULL DEFAULT 0 CHECK(has_error IN (0,1)),uninstalled INTEGER NOT NULL DEFAULT 0 CHECK(uninstalled IN (0,1)),
 grant_version INTEGER NOT NULL CHECK(grant_version>0 AND grant_version<=9007199254740991),last_success_at TEXT);
 CREATE TABLE plugin_source_history(source_instance_id TEXT PRIMARY KEY REFERENCES source_instances(id),plugin_id TEXT NOT NULL REFERENCES plugin_bindings(id));
 PRAGMA user_version=6;
`),
  )()
}
export function createPlugins(
  db: Database.Database,
  receive: (event: SourceEvent, cursor: string) => { inserted: boolean },
) {
  function safe(id: string): SafePlugin {
    text(id)
    const value = db
      .prepare(`${summary} WHERE p.id=? AND p.uninstalled=0`)
      .get(id) as SafePlugin | undefined
    if (!value) throw new Error('PLUGIN_NOT_FOUND')
    return value
  }
  function get(id: string): HostPlugin {
    const value = safe(id)
    const row = db
      .prepare(
        'SELECT p.manifest_json,p.grant_json,p.source_instance_id AS sourceInstanceId,s.cursor FROM plugin_bindings p JOIN source_instances s ON s.id=p.source_instance_id WHERE p.id=?',
      )
      .get(id) as {
      manifest_json: string
      grant_json: string
      sourceInstanceId: string
      cursor: string
    }
    try {
      return {
        ...value,
        manifest: JSON.parse(row.manifest_json) as Record<string, unknown>,
        grant: JSON.parse(row.grant_json) as PluginGrant,
        cursor: row.cursor,
        sourceInstanceId: row.sourceInstanceId,
      }
    } catch {
      invalid()
    }
  }
  return {
    list(): SafePlugin[] {
      return db
        .prepare(`${summary} WHERE p.uninstalled=0 ORDER BY p.id`)
        .all() as SafePlugin[]
    },
    get,
    activate: db.transaction((input: PluginActivation): SafePlugin => {
      keys(input, [
        'id',
        'projectId',
        'displayName',
        'version',
        'digest',
        'manifest',
        'grant',
      ])
      text(input.id, 64)
      text(input.projectId)
      text(input.displayName, 80)
      text(input.version, 128)
      if (
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.id) ||
        typeof input.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.digest)
      )
        invalid()
      const manifest = manifestJson(input.manifest)
      const parsed = JSON.parse(manifest) as Record<string, unknown>
      if (
        parsed.id !== input.id ||
        parsed.version !== input.version ||
        parsed.displayName !== input.displayName ||
        parsed.schemaVersion !== 1 ||
        parsed.sourceType !== 'source'
      )
        invalid()
      const grant = grantJson(input.grant, parsed)
      if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(input.projectId))
        throw new Error('PLUGIN_PROJECT_NOT_FOUND')
      const old = db
        .prepare(
          'SELECT project_id,source_instance_id,version,digest,grant_version,uninstalled FROM plugin_bindings WHERE id=?',
        )
        .get(input.id) as
        | {
            project_id: string
            source_instance_id: string
            version: string
            digest: string
            grant_version: number
            uninstalled: number
          }
        | undefined
      if (old && old.version === input.version && old.digest !== input.digest)
        throw new Error('PLUGIN_VERSION_CONFLICT')
      if (old && !old.uninstalled && old.project_id !== input.projectId)
        throw new Error('PLUGIN_PROJECT_CONFLICT')
      const sourceId =
        old && !old.uninstalled ? old.source_instance_id : randomUUID()
      if (!old || old.uninstalled)
        db.prepare('INSERT INTO source_instances(id) VALUES(?)').run(sourceId)
      db.prepare(
        `INSERT INTO plugin_bindings(id,project_id,source_instance_id,display_name,version,digest,manifest_json,grant_json,grant_version) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,source_instance_id=excluded.source_instance_id,display_name=excluded.display_name,version=excluded.version,digest=excluded.digest,manifest_json=excluded.manifest_json,grant_json=excluded.grant_json,grant_version=excluded.grant_version,enabled=1,has_error=0,uninstalled=0,last_success_at=NULL`,
      ).run(
        input.id,
        input.projectId,
        sourceId,
        input.displayName,
        input.version,
        input.digest,
        manifest,
        grant,
        (old?.grant_version ?? 0) + 1,
      )
      db.prepare(
        'INSERT INTO plugin_source_history(source_instance_id,plugin_id) VALUES(?,?) ON CONFLICT DO NOTHING',
      ).run(sourceId, input.id)
      db.prepare("UPDATE source_instances SET cursor='' WHERE id=?").run(
        sourceId,
      )
      return safe(input.id)
    }),
    disable: db.transaction((id: string): SafePlugin => {
      safe(id)
      db.prepare(
        'UPDATE plugin_bindings SET enabled=0,grant_version=grant_version+1 WHERE id=?',
      ).run(id)
      return safe(id)
    }),
    uninstall: db.transaction((id: string): void => {
      safe(id)
      db.prepare(
        'UPDATE plugin_bindings SET enabled=0,uninstalled=1,grant_version=grant_version+1 WHERE id=?',
      ).run(id)
    }),
    receiveBatch: db.transaction(
      (input: {
        id: string
        grantVersion: number
        expectedCursor: string
        cursor: string
        events: SourceEvent[]
      }): { inserted: number } => {
        integer(input.grantVersion)
        const plugin = get(input.id)
        if (plugin.status === 'disabled') throw new Error('PLUGIN_DISABLED')
        if (plugin.grantVersion !== input.grantVersion)
          throw new Error('PLUGIN_GRANT_CHANGED')
        for (const value of [input.expectedCursor, input.cursor])
          if (
            typeof value !== 'string' ||
            value.length > 16384 ||
            value.includes('\0')
          )
            invalid()
        if (plugin.cursor !== input.expectedCursor)
          throw new Error('PLUGIN_CURSOR_CHANGED')
        if (!Array.isArray(input.events) || input.events.length > 500)
          throw new Error('PLUGIN_LIMIT_EXCEEDED')
        let characters = 0
        for (const event of input.events) {
          try {
            parseSourceEvent(event)
          } catch {
            invalid()
          }
          if (event.sourceInstanceId !== plugin.sourceInstanceId)
            throw new Error('PLUGIN_SOURCE_MISMATCH')
          characters += event.text.length
          if (characters > 4 * 1024 * 1024)
            throw new Error('PLUGIN_LIMIT_EXCEEDED')
        }
        let inserted = 0
        for (const event of input.events) {
          const prior = db
            .prepare(
              'SELECT content,role,occurred_at FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
            )
            .get(plugin.sourceInstanceId, event.externalId, event.revision) as
            | { content: string; role: string; occurred_at: string }
            | undefined
          if (
            prior &&
            (prior.content !== event.text ||
              prior.role !== event.role ||
              prior.occurred_at !== event.occurredAt)
          )
            throw new Error('SOURCE_REVISION_CONFLICT')
          if (receive(event, input.cursor).inserted) inserted++
          const row = db
            .prepare(
              'SELECT id FROM source_events WHERE source_id=? AND external_id=? AND revision=?',
            )
            .get(plugin.sourceInstanceId, event.externalId, event.revision) as {
            id: number
          }
          db.prepare(
            'INSERT INTO event_projects(project_id,event_id) VALUES(?,?) ON CONFLICT DO NOTHING',
          ).run(plugin.projectId, row.id)
        }
        db.prepare('UPDATE source_instances SET cursor=? WHERE id=?').run(
          input.cursor,
          plugin.sourceInstanceId,
        )
        db.prepare(
          'UPDATE plugin_bindings SET last_success_at=?,has_error=0 WHERE id=?',
        ).run(new Date().toISOString(), plugin.id)
        return { inserted }
      },
    ),
    recordError(id: string, grantVersion: number): void {
      text(id)
      integer(grantVersion)
      db.prepare(
        'UPDATE plugin_bindings SET has_error=1 WHERE id=? AND grant_version=? AND enabled=1 AND uninstalled=0',
      ).run(id, grantVersion)
    },
  }
}

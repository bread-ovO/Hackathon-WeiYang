import {
  tokenize,
  identifiers,
  searchTerms,
  TOKENIZER_VERSION,
} from '@memo/application'
import type { Context } from './context'
import { authorized } from './ingestion'
import { requireId } from './util'

export function isSearchReady(ctx: Context): boolean {
  return !!ctx.db
    .prepare(
      `SELECT 1 FROM store_meta ready JOIN store_meta tokenizer
    WHERE ready.key='search_ready' AND ready.value='1'
    AND tokenizer.key='tokenizer_version' AND tokenizer.value=?`,
    )
    .get(TOKENIZER_VERSION)
}

export function syncSearch(ctx: Context, id: string): void {
  const task = ctx.db
    .prepare(
      'SELECT title,version,criteria_version,deleted_at FROM tasks WHERE id=?',
    )
    .get(id) as
    | {
        title: string
        version: number
        criteria_version: number
        deleted_at: string | null
      }
    | undefined
  ctx.db.prepare('DELETE FROM search_identifiers WHERE task_id=?').run(id)
  if (!task || task.deleted_at) {
    ctx.db.prepare('DELETE FROM search_documents WHERE task_id=?').run(id)
    return
  }
  const criteria = ctx.db
    .prepare(
      'SELECT description FROM criteria WHERE task_id=? AND version=? ORDER BY id',
    )
    .all(id, task.criteria_version) as { description: string }[]
  const body = criteria.map((c) => c.description).join('\n')
  const tokens = tokenize(task.title + '\n' + body).join(' ')
  ctx.db
    .prepare(
      `INSERT INTO search_documents(task_id,title,body,tokens,task_version,tokenizer_version) VALUES(?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET title=excluded.title,body=excluded.body,tokens=excluded.tokens,task_version=excluded.task_version,tokenizer_version=excluded.tokenizer_version`,
    )
    .run(id, task.title, body, tokens, task.version, TOKENIZER_VERSION)
  for (const value of identifiers(task.title + '\n' + body))
    ctx.db
      .prepare('INSERT OR IGNORE INTO search_identifiers VALUES(?,?)')
      .run(id, value)
  ctx.fault('search:updated')
}
export interface SearchQuery {
  projectId: string | null
  sourceIds: string[]
  query: string
  limit?: number
}
export interface SearchResult {
  items: { id: string; title: string }[]
  fallback:
    | 'scope_unknown'
    | 'empty_query'
    | 'recent'
    | 'index_unavailable'
    | null
  scanned: number
  tokenizerVersion: string
}
export function searchRepository(ctx: Context) {
  function rebuildSearch(): void {
    const estimate =
      (
        ctx.db
          .prepare(
            'SELECT COALESCE(sum(length(CAST(title AS BLOB))),0) AS n FROM tasks',
          )
          .get() as { n: number }
      ).n +
      (
        ctx.db
          .prepare(
            'SELECT COALESCE(sum(length(CAST(description AS BLOB))),0) AS n FROM criteria',
          )
          .get() as { n: number }
      ).n
    ctx.guard(estimate)
    ctx.db
      .transaction(() => {
        ctx.db
          .prepare("UPDATE store_meta SET value='0' WHERE key='search_ready'")
          .run()
        ctx.db.prepare('DELETE FROM search_documents').run()
        ctx.db.prepare('DELETE FROM search_identifiers').run()
        const rows = ctx.db
          .prepare('SELECT id FROM tasks WHERE deleted_at IS NULL ORDER BY id')
          .all() as { id: string }[]
        for (const row of rows) syncSearch(ctx, row.id)
        ctx.db.prepare("INSERT INTO task_fts(task_fts) VALUES('rebuild')").run()
        ctx.db
          .prepare(
            "INSERT INTO task_fts(task_fts,rank) VALUES('integrity-check',1)",
          )
          .run()
        ctx.db
          .prepare("UPDATE store_meta SET value='1' WHERE key='search_ready'")
          .run()
        ctx.db
          .prepare(
            "INSERT OR REPLACE INTO store_meta VALUES('tokenizer_version',?)",
          )
          .run(TOKENIZER_VERSION)
      })
      .immediate()
    ctx.pauses.delete('search')
  }
  function search(input: SearchQuery): SearchResult {
    if (
      !Array.isArray(input.sourceIds) ||
      input.sourceIds.length > 100 ||
      typeof input.query !== 'string'
    )
      throw new Error('INVALID_SEARCH')
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error('INVALID_SEARCH_LIMIT')
    const { terms, exact, match } = searchTerms(input.query)
    const result: SearchResult = {
      items: [],
      fallback: null,
      scanned: 0,
      tokenizerVersion: TOKENIZER_VERSION,
    }
    if (!input.sourceIds.length || input.projectId === null) {
      result.fallback = 'scope_unknown'
      return result
    }
    input.sourceIds.forEach((id) => {
      requireId(id)
      authorized(ctx, id)
    })
    if (input.projectId !== null) requireId(input.projectId)
    if (!exact || !terms.length) {
      result.fallback = 'empty_query'
      return result
    }
    const sourcePlaceholders = input.sourceIds.map(() => '?').join(',')
    const scope = `t.deleted_at IS NULL AND t.intake='accepted' AND t.archived_at IS NULL
      AND EXISTS(SELECT 1 FROM task_sources ts JOIN source_instances s ON s.id=ts.source_id
      WHERE ts.task_id=t.id AND ts.source_id IN (${sourcePlaceholders}) AND s.active=1
      AND EXISTS(SELECT 1 FROM json_each(s.scopes) WHERE value=ts.scope_id))
      AND NOT EXISTS(SELECT 1 FROM task_sources hidden JOIN source_instances hs ON hs.id=hidden.source_id
      WHERE hidden.task_id=t.id AND (hidden.source_id NOT IN (${sourcePlaceholders}) OR hs.active=0
      OR NOT EXISTS(SELECT 1 FROM json_each(hs.scopes) WHERE value=hidden.scope_id)))`
    const project = input.projectId === null ? '' : ' AND t.project_id=?'
    const params: unknown[] = [
      ...input.sourceIds,
      ...input.sourceIds,
      ...(input.projectId === null ? [] : [input.projectId]),
    ]
    const rows = ctx.db
      .prepare(
        `SELECT t.id,t.title FROM tasks t WHERE ${scope}${project}
      AND EXISTS(SELECT 1 FROM search_identifiers i WHERE i.task_id=t.id AND i.value=?) ORDER BY t.updated_at DESC,t.id LIMIT ?`,
      )
      .all(...params, exact, limit) as { id: string; title: string }[]
    const seen = new Set(rows.map((r) => r.id))
    result.items.push(...rows)
    let ready = isSearchReady(ctx)
    if (ready && rows.length < limit) {
      try {
        const hits = ctx.db
          .prepare(
            `SELECT t.id,t.title FROM task_fts JOIN search_documents sd ON sd.rowid=task_fts.rowid JOIN tasks t ON t.id=sd.task_id
          WHERE ${scope}${project} AND task_fts MATCH ? ORDER BY bm25(task_fts,4.0,1.0),t.updated_at DESC,t.id LIMIT ?`,
          )
          .all(...params, match, 20) as { id: string; title: string }[]
        for (const hit of hits)
          if (!seen.has(hit.id) && result.items.length < limit) {
            result.items.push(hit)
            seen.add(hit.id)
          }
      } catch (error) {
        if (!/no such table|fts5|malformed/i.test((error as Error).message))
          throw error
        ready = false
      }
    }
    if (!result.items.length || !ready) {
      result.fallback = ready ? 'recent' : 'index_unavailable'
      const recent = ctx.db
        .prepare(
          `SELECT t.id,t.title FROM tasks t WHERE ${scope}${project} AND t.updated_at>=? ORDER BY t.updated_at DESC,t.id LIMIT 200`,
        )
        .all(...params, new Date(ctx.now() - 90 * 86400000).toISOString()) as {
        id: string
        title: string
      }[]
      result.scanned = recent.length
      for (const hit of recent) {
        if (!seen.has(hit.id) && result.items.length < limit) {
          result.items.push(hit)
          seen.add(hit.id)
        }
      }
    }
    return result
  }
  return { search, rebuildSearch }
}

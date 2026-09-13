import type Database from 'better-sqlite3'

/** Explicit projection: callers must supply a verified project mapping, never infer it from text. */
export interface SearchProjection {
  projectId: string
  candidateId: string
  title: string
  text: string
  codeIdentifiers: string[]
}
export interface CandidateQuery {
  projectId: string
  text: string
  limit?: number
}
export interface CandidateHit {
  candidateId: string
  title: string
}

function boundedText(
  value: unknown,
  max: number,
  nonempty = false,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (nonempty && !value.trim()) ||
    /[\u0000-\u001f\u007f]/u.test(value.replace(/[\n\r\t]/g, ''))
  ) {
    throw new Error('INVALID_SEARCH_INPUT')
  }
}
function validateProjection(value: SearchProjection) {
  boundedText(value.projectId, 256, true)
  boundedText(value.candidateId, 256, true)
  boundedText(value.title, 512, true)
  boundedText(value.text, 16384)
  if (
    !Array.isArray(value.codeIdentifiers) ||
    value.codeIdentifiers.length > 64
  )
    throw new Error('INVALID_SEARCH_INPUT')
  for (const identifier of value.codeIdentifiers)
    boundedText(identifier, 256, true)
}

// Encoding makes every generated term a single ASCII FTS token, including non-BMP Han.
// No user-controlled FTS operators, quoting, wildcards, or SQL syntax reach MATCH.
function encode(term: string) {
  return `t${Array.from(term, (c) => c.codePointAt(0)!.toString(16)).join('z')}`
}
function terms(text: string, forQuery: boolean): string[] {
  const normalized = text.normalize('NFKC')
  const found = new Set<string>()
  for (const match of normalized.matchAll(
    /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu,
  )) {
    const run = match[0]
    if (/^\p{Script=Han}/u.test(run)) {
      const chars = Array.from(run)
      if (!forQuery || chars.length === 1)
        for (const char of chars) found.add(encode(char))
      for (let i = 0; i + 1 < chars.length; i++)
        found.add(encode(chars[i]! + chars[i + 1]!))
    } else {
      // Store both original identifier and components, while queries use components.
      if (!forQuery) found.add(encode(run.toLowerCase()))
      const parts = run
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
        .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
        .split(' ')
      for (const part of parts) found.add(encode(part.toLowerCase()))
    }
  }
  return [...found]
}
export function projectionTerms(value: SearchProjection) {
  return terms(
    [value.title, value.text, ...value.codeIdentifiers].join(' '),
    false,
  ).join(' ')
}

export function searchMatchExpression(text: string): string | null {
  boundedText(text, 256)
  return terms(text, true).join(' AND ') || null
}

export function migrateSearch(db: Database.Database) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE candidate_search_documents (
        id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, code_identifiers TEXT NOT NULL,
        UNIQUE(project_id, candidate_id)
      );
      CREATE VIRTUAL TABLE candidate_search_fts USING fts5(terms, tokenize = 'ascii');
      PRAGMA user_version = 2;
    `)
  })()
}

export function createCandidateSearch(db: Database.Database) {
  const upsert = db.transaction((value: SearchProjection) => {
    validateProjection(value)
    const row = db
      .prepare(
        `INSERT INTO candidate_search_documents(project_id,candidate_id,title,body,code_identifiers)
      VALUES(?,?,?,?,?) ON CONFLICT(project_id,candidate_id) DO UPDATE SET
      title=excluded.title,body=excluded.body,code_identifiers=excluded.code_identifiers RETURNING id`,
      )
      .get(
        value.projectId,
        value.candidateId,
        value.title,
        value.text,
        JSON.stringify(value.codeIdentifiers),
      ) as { id: number }
    db.prepare('DELETE FROM candidate_search_fts WHERE rowid=?').run(row.id)
    db.prepare('INSERT INTO candidate_search_fts(rowid,terms) VALUES(?,?)').run(
      row.id,
      projectionTerms(value),
    )
  })
  return {
    upsert,
    remove: db.transaction((projectId: string, candidateId: string) => {
      boundedText(projectId, 256, true)
      boundedText(candidateId, 256, true)
      db.prepare(
        `DELETE FROM candidate_search_fts WHERE rowid IN
        (SELECT id FROM candidate_search_documents WHERE project_id=? AND candidate_id=?)`,
      ).run(projectId, candidateId)
      db.prepare(
        'DELETE FROM candidate_search_documents WHERE project_id=? AND candidate_id=?',
      ).run(projectId, candidateId)
    }),
    query({ projectId, text, limit = 20 }: CandidateQuery): CandidateHit[] {
      boundedText(projectId, 256, true)
      boundedText(text, 256)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error('INVALID_SEARCH_LIMIT')
      const queryTerms = terms(text, true)
      if (queryTerms.length === 0) return []
      // Project filtering occurs in SQL before LIMIT, never on an already truncated global list.
      return db
        .prepare(
          `SELECT d.candidate_id AS candidateId,d.title FROM candidate_search_documents d
        JOIN candidate_search_fts f ON f.rowid=d.id
        WHERE d.project_id=? AND candidate_search_fts MATCH ?
        ORDER BY d.candidate_id COLLATE BINARY LIMIT ?`,
        )
        .all(projectId, queryTerms.join(' AND '), limit) as CandidateHit[]
    },
    /** Regenerate only derived tokens from saved projections after a tokenizer change. */
    rebuild: db.transaction(() => {
      db.prepare('DELETE FROM candidate_search_fts').run()
      const insert = db.prepare(
        'INSERT INTO candidate_search_fts(rowid,terms) VALUES(?,?)',
      )
      let lastId = 0
      while (true) {
        const batch = db
          .prepare(
            'SELECT * FROM candidate_search_documents WHERE id > ? ORDER BY id LIMIT 128',
          )
          .all(lastId) as {
          id: number
          project_id: string
          candidate_id: string
          title: string
          body: string
          code_identifiers: string
        }[]
        if (!batch.length) break
        for (const row of batch) {
          const value = {
            projectId: row.project_id,
            candidateId: row.candidate_id,
            title: row.title,
            text: row.body,
            codeIdentifiers: JSON.parse(row.code_identifiers) as string[],
          }
          validateProjection(value)
          insert.run(row.id, projectionTerms(value))
          lastId = row.id
        }
      }
    }),
  }
}

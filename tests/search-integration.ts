import { openStore } from '@memo/storage'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const folder = mkdtempSync(join(tmpdir(), 'bugu-search-'))
const path = join(folder, 'search.sqlite')
try {
  // Build a real v1 database independently of today's openStore migrations.
  const legacy = new Database(path)
  legacy.exec(`
    CREATE TABLE source_instances(id TEXT PRIMARY KEY,cursor TEXT NOT NULL DEFAULT '');
    CREATE TABLE source_events(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL REFERENCES source_instances(id),external_id TEXT NOT NULL,
      revision TEXT NOT NULL,occurred_at TEXT NOT NULL,received_at TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','system')),
      content TEXT NOT NULL,UNIQUE(source_id,external_id,revision));
    CREATE TABLE jobs(id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL UNIQUE REFERENCES source_events(id),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','failed')),attempt INTEGER NOT NULL DEFAULT 0,lease_until TEXT,next_run TEXT,error_code TEXT);
    CREATE INDEX jobs_pending ON jobs(state,next_run);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('todo','in_progress','waiting','completed','cancelled')),
      evidence_status TEXT NOT NULL CHECK(evidence_status IN ('unknown','partial','sufficient','conflict')),version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),archived_at TEXT);
    INSERT INTO source_instances VALUES('synthetic-source','cursor1');
    INSERT INTO source_events VALUES(1,'synthetic-source','e1','1','2026-09-13T00:00:00Z','2026-09-13T00:00:00Z','user','synthetic');
    INSERT INTO jobs(event_id) VALUES(1);
    INSERT INTO tasks(id,title,status,evidence_status) VALUES('legacy','保留任务','todo','unknown');
    PRAGMA user_version=1;
  `)
  legacy.close()
  let store = openStore(path)
  assert.equal(store.health().schemaVersion, 6)
  assert.equal(store.health().eventCount, 1)
  assert.equal(store.health().jobCount, 1)
  assert.equal(store.cursor('synthetic-source'), 'cursor1')
  const raw = new Database(path)
  assert.equal(
    (
      raw.prepare('SELECT title FROM tasks WHERE id=?').get('legacy') as {
        title: string
      }
    ).title,
    '保留任务',
  )
  const search = store.search
  const put = (
    projectId: string,
    candidateId: string,
    title: string,
    text = '',
    codeIdentifiers: string[] = [],
  ) => search.upsert({ projectId, candidateId, title, text, codeIdentifiers })
  const ids = (text: string, projectId = 'p1', limit = 20) =>
    search.query({ projectId, text, limit }).map((hit) => hit.candidateId)
  put('p1', 'c1', '修复登录回调', 'BUGU仓库 登录后修复 修复GitHub登录', [
    'receiveEvent',
    'HTTPServer',
    'Hackathon-WeiYang',
    'source_id',
  ])
  put('p1', 'c2', '验证发布', '部署工作区', ['ship_release'])
  put('p1', 'c3', '𠀀号问题', '组合文本', ['Café'])
  assert.deepEqual(ids('登录'), ['c1'])
  assert.deepEqual(ids('登'), ['c1'])
  assert.deepEqual(ids('BUGU登录'), ['c1'])
  assert.deepEqual(ids('GitHub'), ['c1'])
  assert.deepEqual(ids('GitHub登录'), ['c1'])
  assert.deepEqual(ids('ｂｕｇｕ 登录'), ['c1'])
  assert.deepEqual(ids('hackathon-weiyang'), ['c1'])
  assert.deepEqual(ids('receiveEvent'), ['c1'])
  assert.deepEqual(ids('receive'), ['c1'])
  assert.deepEqual(ids('http server'), ['c1'])
  assert.deepEqual(ids('source_id'), ['c1'])
  assert.deepEqual(ids('cafe\u0301'), ['c3'])
  assert.deepEqual(ids('𠀀'), ['c3'])
  assert.deepEqual(ids('"登录"*'), ['c1'])
  assert.deepEqual(ids('登录 OR 发布'), []) // OR is a literal token, never an operator.
  assert.deepEqual(ids('" : * () -'), [])
  assert.deepEqual(ids("' OR 1=1 --"), [])
  // More foreign candidates than limit; project filtering must precede truncation.
  for (let n = 0; n < 120; n++) put('other', `a${n}`, '登录')
  assert.deepEqual(ids('登录', 'p1', 1), ['c1'])
  assert.deepEqual(ids('登录', "p1' OR 1=1 --"), [])
  assert.deepEqual(ids('登录', 'missing'), [])
  assert.throws(() => ids('a'.repeat(257)), /INVALID_SEARCH_INPUT/)
  for (const limit of [0, 101, 1.5, NaN])
    assert.throws(() => ids('登录', 'p1', limit), /INVALID_SEARCH_LIMIT/)
  assert.throws(
    () =>
      search.upsert({
        projectId: 'p1',
        candidateId: 'c1',
        title: 'bad',
        text: 'x'.repeat(16385),
        codeIdentifiers: [],
      }),
    /INVALID_SEARCH_INPUT/,
  )
  assert.deepEqual(ids('登录'), ['c1'])
  put('p1', 'c2', '已更新标题', '取消发布')
  assert.deepEqual(ids('部署'), [])
  assert.deepEqual(ids('取消'), ['c2'])
  // Corrupt derived index then restore it from saved projections.
  raw.prepare('DELETE FROM candidate_search_fts').run()
  assert.deepEqual(ids('登录'), [])
  search.rebuild()
  assert.deepEqual(ids('登录'), ['c1'])
  // Failed rebuild is atomic: even after deleting FTS rows, prior index remains usable.
  raw
    .prepare(
      "UPDATE candidate_search_documents SET code_identifiers='invalid-json' WHERE candidate_id='c3'",
    )
    .run()
  assert.throws(() => search.rebuild())
  assert.deepEqual(ids('登录'), ['c1'])
  raw
    .prepare(
      "UPDATE candidate_search_documents SET code_identifiers=? WHERE candidate_id='c3'",
    )
    .run('["Café"]')
  search.remove('other', 'c1')
  assert.deepEqual(ids('登录'), ['c1'])
  search.remove('p1', 'c2')
  assert.deepEqual(ids('取消'), [])
  // Known lexical misses: semantic synonyms, typos and arbitrary identifier substrings.
  assert.deepEqual(ids('登入'), [])
  assert.deepEqual(ids('receiv'), [])
  assert.deepEqual(ids('认证'), [])
  raw.close()
  store.close()
  store = openStore(path)
  assert.deepEqual(
    store.search
      .query({ projectId: 'p1', text: '登录' })
      .map((hit) => hit.candidateId),
    ['c1'],
  )
  store.close()
  console.log(
    'Search integration passed: migration, Chinese/mixed/identifier recall, isolation, rebuild, limits; known misses 登入 / receiv / 认证',
  )
} finally {
  rmSync(folder, { recursive: true, force: true })
}

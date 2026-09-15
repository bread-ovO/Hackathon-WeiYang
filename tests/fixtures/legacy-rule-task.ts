/** Seeds a historical v8 rule candidate for migration/provenance tests only.
 * Production no longer has a rule extractor. Callers supply the literal title;
 * this helper never classifies source text or counts toward model accuracy. */
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  ProcessingContext,
  ProcessingResult,
} from '../../packages/storage/src/processing'
import { createRevisionReview } from '../../packages/storage/src/revision-review'
import { createTaskModel } from '../../packages/storage/src/task-model'
import {
  createCandidateSearch,
  projectionTerms,
} from '../../packages/storage/src/search'
import type { openStore } from '@memo/storage'

export function seedLegacyRuleTask(
  path: string,
  context: ProcessingContext,
  result: ProcessingResult,
  title: string,
  dueAt: string | null = null,
): ProcessingResult {
  if (result.outcome !== 'ignored' || result.taskIds.length)
    throw Error('INVALID_LEGACY_FIXTURE')
  const db = new Database(path)
  db.pragma('foreign_keys=ON')
  try {
    return db.transaction(() => {
      const id = randomUUID(),
        quote = context.event.text.trim(),
        start = context.event.text.indexOf(quote),
        end = start + quote.length
      db.prepare(
        "INSERT INTO tasks(id,project_id,title,status,evidence_status,version,manual_version,admission,criteria_version,due_at) VALUES(?,?,?,'todo','unknown',1,0,'candidate',0,?)",
      ).run(id, context.projectId, title, dueAt)
      db.prepare('INSERT INTO processing_origins VALUES(?,?,?,?,?)').run(
        context.projectId,
        context.event.sourceInstanceId,
        context.event.externalId,
        String(start),
        id,
      )
      db.prepare(
        'INSERT INTO processing_evidence(project_id,task_id,event_id,quote_start,quote_end,quote) VALUES(?,?,?,?,?,?)',
      ).run(context.projectId, id, context.eventId, start, end, quote)
      const task = createTaskModel(db).get(context.projectId, id)!
      db.prepare(
        'INSERT INTO task_revisions(task_id,version,decision_id,snapshot) VALUES(?,1,NULL,?)',
      ).run(id, JSON.stringify(task))
      const projection = {
        projectId: context.projectId,
        candidateId: id,
        title,
        text: '',
        codeIdentifiers: [],
      }
      createCandidateSearch(db).upsert(projection)
      const row = db
        .prepare('SELECT rowid AS id FROM tasks WHERE id=?')
        .get(id) as { id: number }
      db.prepare('INSERT INTO task_listing_fts(rowid,terms) VALUES(?,?)').run(
        row.id,
        projectionTerms(projection),
      )
      const payload = {
        version: 'explicit-commitment-v2',
        eventId: context.eventId,
        projectId: context.projectId,
        sourceInstanceId: context.event.sourceInstanceId,
        externalId: context.event.externalId,
        revision: context.event.revision,
        outcome: 'candidates',
        reason: 'explicit_commitment',
        candidates: [
          {
            key: String(start),
            title,
            dueAt,
            quoteStart: start,
            quoteEnd: end,
          },
        ],
      }
      db.prepare(
        "UPDATE processing_results SET outcome='created',reason='explicit_commitment',rule_version='explicit-commitment-v2',payload=?,task_ids=? WHERE event_id=?",
      ).run(JSON.stringify(payload), JSON.stringify([id]), context.eventId)
      db.prepare(
        "INSERT INTO processing_decisions(project_id,task_id,event_id,actor,outcome,reason,created_at) SELECT ?,?,?,'rule','created','explicit_commitment',created_at FROM processing_results WHERE event_id=?",
      ).run(context.projectId, id, context.eventId, context.eventId)
      createRevisionReview(db).observe(context.projectId, context.eventId)
      return { outcome: 'created', taskIds: [id] } as ProcessingResult
    })()
  } finally {
    db.close()
  }
}

// Recorded titles from the existing history/export regression fixtures. These
// are literal test data, not a text grammar or a production extraction fallback.
const historical = new Map<string, [string, string | null]>([
  ['我会提交修复 PR。', ['提交修复 PR', null]],
  ['我会提交审计文档。', ['提交审计文档', null]],
  ['我会完成审计测试。', ['完成审计测试', null]],
  ['我会提交原始版本报告。', ['提交原始版本报告', null]],
  ['我会提交虚构撤回报告。', ['提交虚构撤回报告', null]],
  ['我会提交时间线验收文档。', ['提交时间线验收文档', null]],
  ['我会提交虚构导出报告。', ['提交虚构导出报告', null]],
  ['我会提交虚构报告。', ['提交虚构报告', null]],
  ['我会提交测试报告。', ['提交测试报告', null]],
  ['我会提交规则候选报告。', ['提交规则候选报告', null]],
  ['我会提交另一份报告。', ['提交另一份报告', null]],
  [
    '我会明天下午5点前提交合成验收报告。',
    ['提交合成验收报告', '2026-09-15T09:00:00.000Z'],
  ],
])

/** Observe with production code, then install only an explicitly recorded
 * historical fixture. Used exclusively by legacy provenance compatibility tests. */
export function commitHistoricalFixture(
  store: ReturnType<typeof openStore>,
  path: string,
  ...args: Parameters<ReturnType<typeof openStore>['processing']['commit']>
): ProcessingResult {
  const result = store.processing.commit(...args)
  const context = args[1]
  const fixture = historical.get(context.event.text)
  return fixture &&
    context.event.role === 'user' &&
    result.outcome === 'ignored'
    ? seedLegacyRuleTask(path, context, result, ...fixture)
    : result
}

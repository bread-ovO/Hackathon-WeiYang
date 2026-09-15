import { commitHistoricalFixture } from './fixtures/legacy-rule-task'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-plan-timeline-'))
const path = join(dir, 'db.sqlite')
const store = openStore(path),
  db = new Database(path)
try {
  store.tasks.createProject('a', 'Synthetic project')
  const grant = store.sources.authorize({
    projectId: 'a',
    path: join(dir, 'fictional.jsonl'),
  })
  const metadata = {
    author: { namespace: 'synthetic:user', subjectId: 'person-a' },
  }
  const base: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'original',
    revision: '1',
    occurredAt: '2026-09-13T01:00:00Z',
    role: 'user',
    text: '我会提交时间线验收文档。',
    metadata,
  }
  function process(e: SourceEvent) {
    const g = store.sources.getAuthorized(grant.id)
    store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [e],
      e.externalId,
      g.cursor,
    )
    const now = new Date('2026-09-14T00:00:00Z'),
      lease = store.processing.claim(now)!
    const context = store.processing.load(lease, now)!
    return commitHistoricalFixture(
      store,
      path,
      lease,
      context,
      prepareEventProcessing({
        event: context.event,
        eventId: context.eventId,
        projectId: 'a',
      }),
      now,
    )
  }
  const taskId = process(base).taskIds[0]!
  process({
    ...base,
    externalId: 'reply',
    occurredAt: '2026-09-13T02:00:00Z',
    text: '截止时间改为 2026-09-20T18:00:00+08:00',
    metadata: { ...metadata, replyToExternalId: 'original' },
  })
  const proposal = store.planChanges.list({ projectId: 'a', taskId })
    .proposals[0]!
  assert.equal(proposal.guard, 'ready')
  const task = store.planChanges.confirm(
    {
      projectId: 'a',
      taskId,
      proposalId: proposal.id,
      expectedVersion: proposal.taskVersion,
      expectedCriteriaVersion: proposal.criteriaVersion,
      expectedManualVersion: proposal.manualVersion,
      expectedAssessmentVersion: proposal.assessmentVersion,
      reason: '核对原文后确认',
    },
    'local-user',
  )
  assert.equal(task.dueAt, '2026-09-20T10:00:00.000Z')
  const history = store.timeline.list({ projectId: 'a', taskId })
  const entry = history.entries.find(
    (e) => e.kind === 'manual' && e.changes.some((c) => c.field === 'dueAt'),
  )!
  assert.ok(entry)
  assert.deepEqual(entry.relatedEventIds, [proposal.eventId])
  assert.equal(entry.evidence?.excerpt, proposal.quote)
  const original = db
    .prepare('SELECT * FROM plan_change_proposals WHERE id=?')
    .get(proposal.id) as Record<string, unknown>
  for (const [column, value] of [
    ['quote', 'forged'],
    ['due_at', '2026-09-21T10:00:00.000Z'],
    ['task_version', 999],
    ['created_at', 'invalid'],
    ['applied_at', 'invalid'],
  ] as const) {
    db.prepare(`UPDATE plan_change_proposals SET ${column}=? WHERE id=?`).run(
      value,
      proposal.id,
    )
    assert.throws(
      () => store.timeline.list({ projectId: 'a', taskId }),
      /TIMELINE_CORRUPT_DATA/,
    )
    db.prepare(`UPDATE plan_change_proposals SET ${column}=? WHERE id=?`).run(
      original[column],
      proposal.id,
    )
  }
  db.prepare(
    'UPDATE plan_change_proposals SET applied_at=NULL,decision_id=NULL WHERE id=?',
  ).run(proposal.id)
  assert.throws(
    () => store.timeline.list({ projectId: 'a', taskId }),
    /TIMELINE_CORRUPT_DATA/,
  )
  console.log('plan-change timeline integration passed')
} finally {
  db.close()
  store.close()
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  } catch {}
}

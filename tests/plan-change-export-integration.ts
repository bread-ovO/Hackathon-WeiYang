import { commitHistoricalFixture } from './fixtures/legacy-rule-task'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import type { SourceEvent } from '@memo/contracts'
const dir = mkdtempSync(join(tmpdir(), 'bugu-plan-export-')),
  path = join(dir, 'db.sqlite'),
  store = openStore(path),
  db = new Database(path)
try {
  store.tasks.createProject('a', 'A')
  store.tasks.createProject('b', 'B')
  const grant = store.sources.authorize({
    projectId: 'a',
    path: join(dir, 'synthetic.jsonl'),
  })
  const author = { namespace: 'feishu-open-id', subjectId: 'synthetic-user' }
  function ingest(e: SourceEvent) {
    const g = store.sources.getAuthorized(grant.id)
    store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [e],
      e.externalId + e.revision,
      g.cursor,
    )
  }
  function drain() {
    for (let i = 0; i < 20; i++) {
      const job = store.processing.claim()
      if (!job) return
      const c = store.processing.load(job)!
      commitHistoricalFixture(
        store,
        path,
        job,
        c,
        prepareEventProcessing({
          event: c.event,
          eventId: c.eventId,
          projectId: c.projectId,
        }),
      )
    }
    throw Error('DRAIN_LIMIT')
  }
  const base: SourceEvent = {
    schemaVersion: 1,
    sourceInstanceId: grant.id,
    externalId: 'origin',
    revision: '1',
    role: 'user',
    occurredAt: '2026-09-13T00:00:00Z',
    text: '我会提交虚构导出报告。',
    metadata: { author },
  }
  ingest(base)
  drain()
  const task = store.tasks.list('a')[0]!
  const quote = '截止时间改为 2026-09-20T10:00:00Z'
  ingest({
    ...base,
    externalId: 'reply',
    occurredAt: '2026-09-13T01:00:00Z',
    text: quote,
    metadata: { author, replyToExternalId: 'origin' },
  })
  drain()
  const proposed = store.planChanges.list({ projectId: 'a', taskId: task.id })
    .proposals[0]!
  assert.equal(proposed.guard, 'ready')
  const redacted = store.exports.build({
    projectId: 'a',
    taskIds: [task.id],
    includeSourceText: false,
  })
  assert.equal(redacted.schemaVersion, 7)
  assert.equal(redacted.planChangeProposals.length, 1)
  const row = redacted.planChangeProposals[0]!
  assert.equal(row.status, 'pending')
  assert.equal(row.quote, null)
  assert.ok(redacted.events.some((e) => e.id === row.eventId))
  assert.ok(redacted.events.some((e) => e.id === row.baselineEventId))
  assert.ok(redacted.events.every((e) => e.text === undefined))
  assert.equal(JSON.stringify(redacted).includes(quote), false)
  assert.deepEqual(
    redacted.events.find((e) => e.id === row.eventId)!.metadata,
    { author, replyToExternalId: 'origin' },
  )
  const full = store.exports.build({
    projectId: 'a',
    taskIds: [task.id],
    includeSourceText: true,
  })
  assert.equal(full.planChangeProposals[0]!.quote, quote)
  assert.equal(full.events.find((e) => e.id === row.eventId)!.text, quote)
  store.planChanges.confirm(
    {
      projectId: 'a',
      taskId: task.id,
      proposalId: proposed.id,
      expectedVersion: proposed.taskVersion,
      expectedCriteriaVersion: proposed.criteriaVersion,
      expectedManualVersion: proposed.manualVersion,
      expectedAssessmentVersion: proposed.assessmentVersion,
      reason: 'Adopt this explicit deadline',
    },
    'local-user',
  )
  const applied = store.exports.build({
      projectId: 'a',
      taskIds: [task.id],
      includeSourceText: false,
    }),
    audit = applied.planChangeProposals[0]!
  assert.equal(audit.status, 'applied')
  assert.ok(audit.appliedAt)
  assert.ok(audit.decisionId)
  assert.ok(
    applied.decisions.some(
      (d) =>
        d.id === audit.decisionId &&
        d.actor === 'manual' &&
        d.inputRefs.includes(audit.eventId),
    ),
  )
  assert.equal(JSON.stringify(applied).includes(quote), false)
  store.tasks.create(
    { id: 'unrelated', projectId: 'a', title: 'Unrelated' },
    { actorId: 'local-user', reason: 'Create another task' },
  )
  store.tasks.create(
    { id: 'cross-project', projectId: 'b', title: 'Foreign' },
    { actorId: 'local-user', reason: 'Create another task' },
  )
  const other = store.exports.build({
    projectId: 'a',
    taskIds: ['unrelated'],
    includeSourceText: true,
  })
  assert.deepEqual(other.planChangeProposals, [])
  assert.equal(other.events.length, 0)
  assert.throws(
    () =>
      store.exports.build({
        projectId: 'a',
        taskIds: ['cross-project'],
        includeSourceText: false,
      }),
    /EXPORT_TASK_NOT_IN_PROJECT/,
  )
  const foreign = store.exports.build({
    projectId: 'b',
    includeSourceText: true,
  })
  assert.deepEqual(foreign.planChangeProposals, [])
  // A broken applied-decision link must not be projected as legitimate audit history.
  const otherDecision = other.decisions[0]!.id
  db.prepare('UPDATE plan_change_proposals SET decision_id=? WHERE id=?').run(
    otherDecision,
    proposed.id,
  )
  assert.throws(
    () =>
      store.exports.build({
        projectId: 'a',
        taskIds: [task.id],
        includeSourceText: false,
      }),
    /EXPORT_CORRUPT_DATA/,
  )
  db.prepare('UPDATE plan_change_proposals SET decision_id=? WHERE id=?').run(
    audit.decisionId,
    proposed.id,
  )
  console.log(
    'Plan change export integration passed: v6, pending/applied proofs, redaction, task/project isolation and corruption',
  )
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

import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import { TASK_ANALYSIS_VERSION } from '@memo/model'
import type { TaskAnalysis } from '@memo/contracts'

const dir = mkdtempSync(join(tmpdir(), 'bugu-model-only-'))
const file = join(dir, 'memo.sqlite')
let store = openStore(file)
try {
  store.tasks.createProject('p', '合成项目')
  store.tasks.createProject('other', '隔离项目')
  const grant = store.sources.authorize({
    projectId: 'p',
    path: join(dir, 'synthetic.jsonl'),
  })
  const receive = (id: string, text: string, revision = '1') => {
    const g = store.sources.getAuthorized(grant.id)
    store.sources.receiveBatch(
      grant.id,
      g.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: grant.id,
          externalId: id,
          revision,
          occurredAt: '2026-09-15T00:00:00Z',
          role: 'user',
          text,
        },
      ],
      id + revision,
      g.cursor,
    )
  }
  receive('request', '我来修复附件预览失败的问题。')
  for (let i = 0; i < 70; i++) receive(`noise-${i}`, `闲聊 ${i}：天气很舒服。`)
  receive('acceptance', '附件预览已经验收通过。')
  const observe = () => {
    for (let i = 0; i < 100; i++) {
      const job = store.processing.claim()
      if (!job) return
      const c = store.processing.load(job)!
      store.processing.commit(
        job,
        c,
        prepareEventProcessing({
          event: c.event,
          eventId: c.eventId,
          projectId: c.projectId,
        }),
      )
    }
    throw Error('TEST_JOB_LIMIT')
  }
  observe()
  assert.equal(
    store.tasks.list('p').length,
    0,
    'source observation must not create rule candidates',
  )
  const first = store.taskAnalysis.context(grant.id, 0, TASK_ANALYSIS_VERSION)
  assert.equal(first.newMessageCount, 48)
  assert.equal(first.messages[0]!.text, '我来修复附件预览失败的问题。')
  const request = first.messages[0]!
  const task: TaskAnalysis['tasks'][number] = {
    title: '修复附件预览失败',
    stage: 'requested',
    nextAction: '修复并验证附件预览',
    evidence: [{ messageId: request.id, quote: request.text }],
  }
  const result = { tasks: [task] }
  const inspect = new Database(file)
  inspect.exec(
    "CREATE TRIGGER fail_window BEFORE INSERT ON model_analysis_windows BEGIN SELECT RAISE(ABORT,'window failure'); END",
  )
  assert.throws(
    () =>
      store.taskAnalysis.save(first, result, 'fixture', TASK_ANALYSIS_VERSION),
    /window failure/,
  )
  assert.equal(
    (
      inspect.prepare('SELECT count(*) AS n FROM model_analyses').get() as {
        n: number
      }
    ).n,
    0,
    'analysis and window checkpoint commit atomically',
  )
  inspect.exec('DROP TRIGGER fail_window')
  inspect.close()
  const run = store.taskAnalysis.discover(
    first,
    result,
    'synthetic-provider',
    TASK_ANALYSIS_VERSION,
  )
  store.taskAnalysis.discover(
    first,
    result,
    'synthetic-provider',
    TASK_ANALYSIS_VERSION,
  )
  const id = store.tasks.list('p')[0]!.id
  assert.equal(store.tasks.list('p').length, 1)
  assert.equal(store.tasks.get('p', id)!.status, 'todo')
  assert.equal(store.tasks.get('p', id)!.admission, 'candidate')
  assert.deepEqual(store.taskAnalysis.accepted(run), [0])
  store.close()
  store = openStore(file)
  const pending = store.taskAnalysis
    .pending(TASK_ANALYSIS_VERSION)
    .find((p) => p.sourceId === grant.id)!
  assert.equal(
    pending.afterEventId,
    first.endEventId,
    'restart continues at the next window',
  )
  const second = store.taskAnalysis.context(
    grant.id,
    pending.afterEventId,
    TASK_ANALYSIS_VERSION,
  )
  assert.equal(second.hasMore, false)
  assert.equal(second.knownTasks[0]!.id, id)
  assert(
    second.messages.some((m) => m.id === request.id),
    'original request survives a distant status update',
  )
  const confirmation = second.messages.find(
    (m) => m.text === '附件预览已经验收通过。',
  )!
  const accepted: TaskAnalysis = {
    tasks: [
      {
        ...task,
        title: '附件预览修复',
        existingTaskId: id,
        stage: 'accepted',
        nextAction: '',
        evidence: [
          ...task.evidence,
          { messageId: confirmation.id, quote: confirmation.text },
        ],
      },
    ],
  }
  const alien = store.tasks.create(
    { id: 'foreign-task', projectId: 'other', title: '另一项目的任务' },
    { actorId: 'fixture', reason: '隔离测试' },
  )
  assert.throws(
    () =>
      store.taskAnalysis.discover(
        second,
        { tasks: [{ ...accepted.tasks[0]!, existingTaskId: alien.id }] },
        'fixture',
        TASK_ANALYSIS_VERSION,
      ),
    /INVALID_TASK_ANALYSIS/,
  )
  assert.throws(
    () =>
      store.taskAnalysis.discover(
        second,
        {
          tasks: [
            {
              ...accepted.tasks[0]!,
              evidence: [
                { messageId: confirmation.id, quote: confirmation.text },
              ],
            },
          ],
        },
        'fixture',
        TASK_ANALYSIS_VERSION,
      ),
    /INVALID_TASK_ANALYSIS/,
  )
  store.taskAnalysis.discover(
    second,
    accepted,
    'synthetic-provider',
    TASK_ANALYSIS_VERSION,
  )
  assert.equal(
    store.tasks.list('p').length,
    1,
    'the model refers to the existing task even when its title is reworded',
  )
  assert.equal(store.taskAnalysis.forTask('p', id)!.candidate.stage, 'accepted')
  assert.equal(
    store.tasks.get('p', id)!.status,
    'todo',
    'a model acceptance is not business completion',
  )
  assert.equal(store.taskAnalysis.pending(TASK_ANALYSIS_VERSION).length, 0)
  receive('new', '另外，请补充退款说明。')
  const appended = store.taskAnalysis
    .pending(TASK_ANALYSIS_VERSION)
    .find((p) => p.sourceId === grant.id)!
  assert.equal(
    appended.afterEventId,
    second.endEventId,
    'append resumes after the immutable partial page',
  )
  const next = store.taskAnalysis.context(
    grant.id,
    appended.afterEventId,
    TASK_ANALYSIS_VERSION,
  )
  const newRequest = next.messages.find(
    (m) => m.text === '另外，请补充退款说明。',
  )!
  const newResult: TaskAnalysis = {
    tasks: [
      {
        title: '补充退款说明',
        stage: 'requested',
        nextAction: '编写退款说明',
        evidence: [{ messageId: newRequest.id, quote: newRequest.text }],
      },
    ],
  }
  // An append during inference is safe; it must not discard a completed prefix.
  receive('later', '只是聊聊今天的天气。')
  store.taskAnalysis.discover(next, newResult, 'fixture', TASK_ANALYSIS_VERSION)
  assert.equal(store.tasks.list('p').length, 2)
  assert.equal(
    store.taskAnalysis.pending(TASK_ANALYSIS_VERSION)[0]!.afterEventId,
    next.endEventId,
  )
  const current = store.taskAnalysis.context(
    grant.id,
    next.endEventId,
    TASK_ANALYSIS_VERSION,
  )
  store.sources.revoke(grant.id)
  assert.throws(
    () =>
      store.taskAnalysis.save(
        current,
        { tasks: [] },
        'fixture',
        TASK_ANALYSIS_VERSION,
      ),
    /ANALYSIS_SOURCE_UNAVAILABLE/,
  )
  assert.equal(store.tasks.list('other').length, 1)
  console.log(
    'Model-only extraction integration passed: no rules, paged history, restart, target authority, replay, append and revoke',
  )
} finally {
  store.close()
  rmSync(dir, { recursive: true, force: true })
}

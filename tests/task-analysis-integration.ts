import { openStore } from '@memo/storage'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
const folder = mkdtempSync(join(tmpdir(), 'bugu-model-storage-'))
const path = join(folder, 'memo.sqlite')
let store = openStore(path)
try {
  store.tasks.createProject('a', '合成分析测试')
  store.tasks.createProject('b', '隔离项目')
  const start=Date.parse('2026-09-14T00:00:00Z')
  const f=store.feishu.authorize({projectId:'b',chatId:'oc_synthetic_analysis',credentialId:'00000000-0000-4000-8000-000000000001',startTime:start,endTime:start+86400000})
  const fg=store.feishu.getAuthorized(f.id)
  store.feishu.receiveBatch({id:f.id,expectedGrantVersion:fg.grantVersion,expectedPollVersion:fg.pollVersion,expectedPageToken:fg.pageToken,expectedWindowStart:fg.windowStart,expectedWindowEnd:fg.windowEnd,events:[{schemaVersion:1,sourceInstanceId:f.id,externalId:'fake_message',revision:'1',occurredAt:new Date(start+1000).toISOString(),role:'user',text:'请准备周会材料。'}],nextPageToken:'',nextPollAt:0})
  const fc=store.taskAnalysis.context(f.id)
  const fr=store.taskAnalysis.save(fc,{tasks:[{title:'准备周会材料',stage:'requested',nextAction:'整理材料',evidence:[{messageId:fc.messages[0]!.id,quote:'请准备周会材料。'}]}]},'fixture','feishu-test')
  assert.equal(store.taskAnalysis.latest('feishu-test')?.runId,fr)
  store.feishu.setEnabled(f.id,false)
  assert.throws(()=>store.taskAnalysis.accept(fr,0),/ANALYSIS_SOURCE_UNAVAILABLE/)
  store.feishu.setEnabled(f.id,true)
  assert.throws(()=>store.taskAnalysis.accept(fr,0),/ANALYSIS_CONTEXT_CHANGED/)
  store.feishu.revoke(f.id)
  assert.throws(()=>store.taskAnalysis.context(f.id),/ANALYSIS_SOURCE_UNAVAILABLE/)

  const grant = store.sources.authorize({
    path: join(folder, 'synthetic.jsonl'),
    projectId: 'a',
  })
  const receive = (id: string, text: string) => {
    const current = store.sources.getAuthorized(grant.id)
    store.sources.receiveBatch(
      grant.id,
      current.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: grant.id,
          externalId: id,
          revision: '1',
          occurredAt: '2026-09-14T00:00:00Z',
          role: 'user',
          text,
        },
      ],
      id,
      current.cursor,
    )
  }
  receive('m1', '修复登录白屏。')
  const context = store.taskAnalysis.context(grant.id)
  const proposal = {
    tasks: [
      {
        title: '修复登录白屏',
        stage: 'requested' as const,
        nextAction: '检查登录回调',
        evidence: [
          { messageId: context.messages[0]!.id, quote: '修复登录白屏。' },
        ],
      },
    ],
  }
  const run = store.taskAnalysis.save(context, proposal, 'test-model', 'v1')
  assert.equal(
    store.taskAnalysis.save(context, proposal, 'test-model', 'v1'),
    run,
  )
  store.taskAnalysis.accept(run, 0)
  store.taskAnalysis.accept(run, 0)
  assert.deepEqual(store.taskAnalysis.accepted(run), [0])
  const inspect = new Database(path, { readonly: true })
  const savedTask = inspect
    .prepare('SELECT id,status,title FROM tasks')
    .get() as { id: string; status: string; title: string }
  assert.equal(savedTask.status, 'todo')
  assert.equal(
    store.taskAnalysis.forTask('a', savedTask.id)?.candidate.nextAction,
    '检查登录回调',
  )
  assert.equal(store.taskAnalysis.forTask('b', savedTask.id), null)
  inspect.close()
  store.close()
  store = openStore(path)
  assert.deepEqual(store.taskAnalysis.accepted(run), [0])
  assert.throws(
    () => store.taskAnalysis.accept(run, 8),
    /INVALID_TASK_ANALYSIS/,
  )
  assert.throws(
    () =>
      store.taskAnalysis.save(
        context,
        {
          tasks: [
            {
              ...proposal.tasks[0]!,
              evidence: [{ messageId: 'invented', quote: 'x' }],
            },
          ],
        },
        'test',
        'v1',
      ),
    /INVALID_TASK_ANALYSIS/,
  )
  receive('m2', '还要补回归测试。')
  assert.throws(
    () => store.taskAnalysis.save(context, proposal, 'test-model', 'v1'),
    /ANALYSIS_CONTEXT_CHANGED/,
  )
  assert.throws(
    () => store.taskAnalysis.accept(run, 0),
    /ANALYSIS_CONTEXT_CHANGED/,
  )
  const newer = store.taskAnalysis.context(grant.id)
  const nextRun = store.taskAnalysis.save(newer, proposal, 'test-model', 'v1')
  store.taskAnalysis.accept(nextRun, 0)
  const inspectAgain = new Database(path, { readonly: true })
  assert.equal(
    (
      inspectAgain.prepare('SELECT count(*) AS n FROM tasks').get() as {
        n: number
      }
    ).n,
    1,
  )
  inspectAgain.close()
  assert.equal(store.taskAnalysis.latest('v1')?.runId, nextRun)
  assert.equal(store.taskAnalysis.latest('v1')?.model, 'test-model')
  assert.equal(store.taskAnalysis.latest('unavailable'), null)
  const two = { tasks: [proposal.tasks[0]!, { ...proposal.tasks[0]!, title: '补充回归测试' }] }
  const twoRun = store.taskAnalysis.save(newer, two, 'test-model','two-distinct-tasks')
  store.taskAnalysis.accept(twoRun,0)
  store.taskAnalysis.accept(twoRun,1)
  const inspectDistinct = new Database(path, {readonly:true})
  assert.equal((inspectDistinct.prepare('SELECT count(*) AS n FROM tasks').get() as {n:number}).n,2)
  inspectDistinct.close()
  // Background discovery persists candidates and provenance atomically, without accepting work.
  const autoProtocol = 'automatic-test'
  assert.equal(store.taskAnalysis.pending(autoProtocol).some(x => x.sourceId === grant.id), true)
  const automatic = { tasks: [{ ...proposal.tasks[0]!, title: '自动发现的独立事项' }] }
  const autoRun = store.taskAnalysis.discover(newer, automatic, 'fixture', autoProtocol)
  assert.equal(store.taskAnalysis.pending(autoProtocol).some(x => x.sourceId === grant.id), false)
  store.taskAnalysis.discover(newer, automatic, 'fixture', autoProtocol)
  const autoDb = new Database(path, {readonly:true})
  const candidates = autoDb.prepare("SELECT id,admission,status FROM tasks WHERE title='自动发现的独立事项'").all() as {id:string;admission:string;status:string}[]
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.admission, 'candidate')
  assert.equal(candidates[0]!.status, 'todo')
  assert.equal(store.taskAnalysis.forTask('a', candidates[0]!.id)?.sourceName, 'synthetic.jsonl')
  assert.equal(store.taskAnalysis.forTask('a', candidates[0]!.id)?.sourceId, grant.id)
  assert.deepEqual(store.taskAnalysis.accepted(autoRun), [0])
  autoDb.close()
  store.sources.revoke(grant.id)
  assert.throws(
    () => store.taskAnalysis.context(grant.id),
    /ANALYSIS_SOURCE_UNAVAILABLE/,
  )
  console.log(
    'Task analysis storage: exact evidence, idempotency, restart, stale context and revoke passed',
  )
} finally {
  store.close()
  rmSync(folder, { recursive: true, force: true })
}

import { openStore, type StoredTask } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import { createGithubAccountFetcher } from '@memo/connectors'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
const dir = mkdtempSync(join(tmpdir(), 'bugu-five-')),
  path = join(dir, 'store.sqlite')
let store = openStore(path)
const by = { actorId: 'synthetic', reason: '明确合并重复事项' }
const expected = (t: StoredTask) => ({
  taskId: t.id,
  projectId: t.projectId!,
  expectedVersion: t.version,
  expectedCriteriaVersion: t.criteriaVersion,
  expectedManualVersion: t.manualVersion,
})
async function main() {
  try {
    store.tasks.createProject('p', '合成项目')
    store.tasks.createProject('other', '其他项目')
    const grant = store.sources.authorize({
      projectId: 'p',
      path: join(dir, 'synthetic.jsonl'),
    })
    const text = '我会明天下午5点前提交合成验收报告。'
    store.sources.receiveBatch(
      grant.id,
      grant.grantVersion,
      [
        {
          schemaVersion: 1,
          sourceInstanceId: grant.id,
          externalId: 'message',
          revision: '1',
          role: 'user',
          text,
          occurredAt: '2026-09-14T23:30:00+08:00',
        },
      ],
      'one',
      '',
    )
    const now = new Date('2026-09-16T00:00:00Z'),
      job = store.processing.claim(now)!,
      context = store.processing.load(job, now)!
    const result = store.processing.commit(
      job,
      context,
      prepareEventProcessing({
        event: context.event,
        eventId: context.eventId,
        projectId: context.projectId,
      }),
      now,
    )
    let source = store.tasks.get('p', result.taskIds[0]!)!
    assert.equal(source.dueAt, '2026-09-15T09:00:00.000Z')
    source = store.tasks.replaceCriteria(
      expected(source),
      [
        {
          id: 'source-condition',
          description: '提交报告',
          originEventId: context.eventId,
        },
        {
          id: 'duplicate',
          description: '复核报告',
          originEventId: context.eventId,
        },
      ],
      by,
    )
    source = store.tasks.addEvidence(
      expected(source),
      {
        id: 'original-evidence',
        criterionId: 'source-condition',
        criteriaVersion: source.criteriaVersion,
        eventId: context.eventId,
        relation: 'supports',
        validity: 'valid',
        reason: '合成依据',
      },
      by,
    )
    let target = store.tasks.create(
      {
        id: 'target',
        projectId: 'p',
        title: '目标报告',
        admission: 'accepted',
      },
      by,
    )
    target = store.tasks.replaceCriteria(
      expected(target),
      [{ id: 'own-condition', description: '复核报告' }],
      by,
    )
    const foreign = store.tasks.create(
      { id: 'foreign', projectId: 'other', title: '其他项目' },
      by,
    )
    assert.throws(
      () => store.tasks.merge(expected(source), expected(foreign), by),
      /INVALID_TASK_MERGE/,
    )
    assert.throws(
      () =>
        store.tasks.merge(
          expected(source),
          { ...expected(target), expectedVersion: 1 },
          by,
        ),
      /VERSION_CONFLICT/,
    )
    assert.equal(store.tasks.get('p', source.id)!.archivedAt, null)
    const oldSource = expected(source),
      oldTarget = expected(target)
    target = store.tasks.merge(oldSource, oldTarget, by)
    assert.equal(target.status, 'todo')
    assert.equal(target.evidenceStatus, 'unknown')
    assert.equal(target.dueAt, null)
    assert.equal(store.tasks.mergeInfo('p', source.id).mergedInto, 'target')
    assert.equal(store.tasks.getCriteria('p', 'target').items.length, 2)
    assert.equal(store.tasks.getCriteria('p', source.id).items.length, 2)
    assert.ok(store.tasks.get('p', source.id)!.archivedAt)
    assert.equal(
      store.processing.getTaskEvidence('p', 'target')[0]!.quote,
      text,
    )
    assert.throws(
      () => store.tasks.merge(oldSource, oldTarget, by),
      /VERSION_CONFLICT|TASK_MERGED/,
    )
    assert.throws(
      () =>
        store.tasks.update(
          expected(store.tasks.get('p', source.id)!),
          { title: '不能修改' },
          by,
        ),
      /TASK_MERGED/,
    )
    assert.ok(
      store.timeline
        .list({ projectId: 'p', taskId: 'target' })
        .entries.some((e) => e.changes.some((c) => c.field === 'merge')),
    )
    assert.ok(
      store.timeline
        .list({ projectId: 'p', taskId: source.id })
        .entries.some((e) => e.changes.some((c) => c.field === 'merge')),
    )
    const db = new Database(path)
    const evidence = db
      .prepare("SELECT validity FROM evidence_links WHERE task_id='target'")
      .get() as { validity: string }
    assert.equal(evidence.validity, 'unknown')
    assert.equal(
      store.tasks.listPage({ sourceInstanceId: grant.id }).totalCount,
      1,
    )
    assert.equal(
      store.tasks.listPage({ projectId: 'other', sourceInstanceId: grant.id })
        .totalCount,
      0,
    )
    assert.equal(
      store.tasks.listPage({ updatedSince: '2000-01-01T00:00:00.000Z' })
        .totalCount,
      2,
    )
    assert.equal(
      store.tasks.listPage({ updatedBefore: '2000-01-01T00:00:00.000Z' })
        .totalCount,
      0,
    )
    const page = store.tasks.listPage({ limit: 1 })
    assert.ok(page.nextCursor)
    assert.throws(
      () =>
        store.tasks.listPage({
          limit: 1,
          cursor: page.nextCursor!,
          sourceInstanceId: grant.id,
        }),
      /INVALID_TASK_CURSOR/,
    )
    const final = store.tasks.create(
      { id: 'final', projectId: 'p', title: '最终保留事项' },
      by,
    )
    store.tasks.merge(expected(target), expected(final), by)
    assert.equal(store.tasks.mergeInfo('p', source.id).mergedInto, 'final')
    assert.equal(store.tasks.mergeInfo('p', 'target').mergedInto, 'final')
    assert.ok(
      store.timeline.list({ projectId: 'p', taskId: source.id }).entries.length,
    )
    db.close()
    const github = store.github.authorize({
      projectId: 'p',
      credentialId: '00000000-0000-4000-8000-000000000001',
      mode: 'account',
      owner: 'synthetic',
      repo: '',
      repositoryId: 42,
    })
    const repo = {
      id: 7,
      full_name: 'synthetic/repo',
      html_url: 'https://github.com/synthetic/repo',
      updated_at: '2026-09-14T09:00:00Z',
      description: 'fixture',
    }
    const fetch = createGithubAccountFetcher('synthetic', 42, async (r) => ({
      status: 200,
      headers: {},
      body: r.url.endsWith('/user')
        ? { id: 42, login: 'synthetic' }
        : r.url.includes('/user/repos?')
          ? [repo]
          : r.url.endsWith('/repos/synthetic/repo')
            ? repo
            : [],
    }))
    const batch = await fetch('', new AbortController().signal)
    let binding = store.github.getAuthorized(github.id)
    store.github.receiveBatch({
      id: github.id,
      expectedGrantVersion: binding.grantVersion,
      expectedPollVersion: binding.pollVersion,
      expectedCursor: '',
      events: batch.events.map((e) => ({ ...e, sourceInstanceId: github.id })),
      nextCursor: batch.nextCursor,
      nextPollAt: 0,
    })
    assert.equal(store.github.records({ id: github.id }).records.length, 1)
    store.close()
    store = openStore(path)
    binding = store.github.getAuthorized(github.id)
    assert.equal(binding.cursor, batch.nextCursor)
    assert.equal(binding.mode, 'account')
    assert.equal(store.tasks.mergeInfo('p', source.id).mergedInto, 'final')
    assert.throws(
      () =>
        store.github.receiveBatch({
          id: github.id,
          expectedGrantVersion: binding.grantVersion,
          expectedPollVersion: binding.pollVersion,
          expectedCursor: binding.cursor,
          events: batch.events.map((e) => ({
            ...e,
            sourceInstanceId: github.id,
            text: e.text.replace('fixture', 'tampered'),
          })),
          nextCursor: '',
          nextPollAt: 0,
        }),
      /GITHUB_INVALID_INPUT/,
    )
    assert.equal(store.github.getAuthorized(github.id).cursor, batch.nextCursor)
    store.github.setEnabled(github.id, false)
    assert.throws(
      () =>
        store.github.receiveBatch({
          id: github.id,
          expectedGrantVersion: binding.grantVersion,
          expectedPollVersion: binding.pollVersion,
          expectedCursor: binding.cursor,
          events: [],
          nextCursor: '',
          nextPollAt: 0,
        }),
      /GITHUB_GRANT_CHANGED/,
    )
    console.log('five requirements storage integration passed')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
void main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})

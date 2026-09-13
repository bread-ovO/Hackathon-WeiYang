import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  githubObjectUrl,
  githubObjectLinks,
  describesFeedback,
} from '@memo/domain'
import {
  parseGithubAccountObservation,
  type DeliverySummary,
  type DeliveryEvidence,
} from '@memo/contracts'
import { createTaskModel, type StoredTask } from './task-model'
import { getSourceStatus } from './source-status'
import { createRetractions } from './retractions'
import { eventMetadataFields } from './event-metadata'
import { createSourceAssociations } from './source-associations'
type Config = {
  task_id: string
  project_id: string
  target_url: string
  criteria_version: number
  pr_criterion: string
  feedback_criterion: string
  baseline_event: number | null
  backfill_limited: number
}
type Event = {
  id: number
  source_id: string
  external_id: string
  revision: string
  content: string
  role: string
  operation: string
  occurred_at: string
  metadata_json: string | null
}
type Link = {
  task_id: string
  event_id: number
  kind: DeliveryEvidence['kind']
  decision: 'auto' | 'pending' | 'confirm' | 'reject'
  reason: string
  url: string | null
}
export type DeliveryExpectation = {
  projectId: string
  taskId: string
  expectedTaskVersion: number
  expectedCriteriaVersion: number
  expectedManualVersion: number
}
export function migrateDelivery(db: Database.Database) {
  db.transaction(() =>
    db.exec(`
 CREATE TABLE delivery_workflows(task_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,target_url TEXT NOT NULL,criteria_version INTEGER NOT NULL,pr_criterion TEXT NOT NULL,feedback_criterion TEXT NOT NULL,baseline_event INTEGER REFERENCES source_events(id),backfill_limited INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(task_id,project_id) REFERENCES tasks(id,project_id));
 CREATE TABLE delivery_links(task_id TEXT NOT NULL,event_id INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('pr','feedback','progress')),decision TEXT NOT NULL CHECK(decision IN('auto','pending','confirm','reject')),reason TEXT NOT NULL,url TEXT,PRIMARY KEY(task_id,event_id),FOREIGN KEY(task_id) REFERENCES delivery_workflows(task_id),FOREIGN KEY(event_id) REFERENCES source_events(id));
 CREATE INDEX delivery_event ON delivery_links(event_id);
 CREATE TABLE delivery_audit(id INTEGER PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),event_id INTEGER REFERENCES source_events(id),action TEXT NOT NULL,recorded_at TEXT NOT NULL,actor TEXT NOT NULL);
 PRAGMA user_version=22;
 `),
  )()
}
export function createDelivery(db: Database.Database) {
  const tasks = createTaskModel(db)
  function task(p: string, id: string) {
    const t = tasks.get(p, id)
    if (!t) throw Error('TASK_NOT_IN_PROJECT')
    return t
  }
  function expect(i: DeliveryExpectation) {
    const t = task(i.projectId, i.taskId)
    if (
      t.version !== i.expectedTaskVersion ||
      t.criteriaVersion !== i.expectedCriteriaVersion ||
      t.manualVersion !== i.expectedManualVersion
    )
      throw Error('VERSION_CONFLICT')
    if (
      t.status === 'cancelled' ||
      t.status === 'completed' ||
      t.archivedAt ||
      t.admission !== 'accepted' ||
      tasks.mergeInfo(i.projectId, i.taskId).mergedInto
    )
      throw Error('DELIVERY_READONLY')
    return t
  }
  const expectation = (t: StoredTask) => ({
    projectId: t.projectId!,
    taskId: t.id,
    expectedVersion: t.version,
    expectedCriteriaVersion: t.criteriaVersion,
    expectedManualVersion: t.manualVersion,
  })
  const config = (id: string) =>
    db.prepare('SELECT * FROM delivery_workflows WHERE task_id=?').get(id) as
      | Config
      | undefined
  const event = (p: string, id: number) =>
    db
      .prepare(
        'SELECT e.* FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? AND e.id=?',
      )
      .get(p, id) as Event | undefined
  function usable(p: string, e: Event) {
    if (
      e.operation !== 'upsert' ||
      !['active', 'paused'].includes(getSourceStatus(db, p, e.source_id)) ||
      createRetractions(db).forEvent(p, e.id)
    )
      return false
    if (
      db
        .prepare(
          'SELECT 1 FROM github_connections WHERE project_id=? AND source_id=?',
        )
        .get(p, e.source_id)
    ) {
      return !db
        .prepare(
          'SELECT 1 FROM source_events n JOIN event_projects ep ON ep.event_id=n.id WHERE ep.project_id=? AND n.source_id=? AND n.external_id=? AND n.id<>? AND (julianday(n.occurred_at)>julianday(?) OR (julianday(n.occurred_at)=julianday(?) AND n.content<>?)) LIMIT 1',
        )
        .get(
          p,
          e.source_id,
          e.external_id,
          e.id,
          e.occurred_at,
          e.occurred_at,
          e.content,
        )
    }
    // No automatic choice between revised source bodies, including backdated revisions.
    return !db
      .prepare(
        "SELECT 1 FROM source_events n JOIN event_projects ep ON ep.event_id=n.id WHERE ep.project_id=? AND n.source_id=? AND n.external_id=? AND n.id<>? AND (n.content<>? OR n.role<>? OR n.operation<>? OR coalesce(n.metadata_json,'')<>coalesce(?,'')) LIMIT 1",
      )
      .get(
        p,
        e.source_id,
        e.external_id,
        e.id,
        e.content,
        e.role,
        e.operation,
        e.metadata_json,
      )
  }
  function audit(id: string, e: number | null, action: string, actor = 'rule') {
    db.prepare(
      'INSERT INTO delivery_audit(task_id,event_id,action,recorded_at,actor) VALUES(?,?,?,?,?)',
    ).run(id, e, action, new Date().toISOString(), actor)
  }
  function pr(
    p: string,
    e: Event,
  ): { url: string; body: string; submitted: boolean } | null {
    if (
      e.role !== 'tool' ||
      !db
        .prepare(
          'SELECT 1 FROM github_connections WHERE source_id=? AND project_id=?',
        )
        .get(e.source_id, p)
    )
      return null
    // Connector storage validates these envelopes; local JSONL cannot impersonate GitHub.
    let v: Record<string, unknown>
    try {
      v = JSON.parse(e.content)
    } catch {
      return null
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    if (v.kind === 'github-account-observation') {
      try {
        parseGithubAccountObservation(v)
      } catch {
        return null
      }
    }
    if (
      v.kind === 'github-pull-request' ||
      (v.kind === 'github-account-observation' &&
        v.objectKind === 'pull-request')
    ) {
      const url = typeof v.url === 'string' ? githubObjectUrl(v.url) : null
      if (!url || !url.includes('/pull/')) return null
      return {
        url,
        body: typeof v.body === 'string' ? v.body : '',
        submitted: v.state === 'open' || v.state === 'merged',
      }
    }
    return null
  }
  function classify(
    c: Config,
    e: Event,
  ): {
    kind: Link['kind']
    reason: string
    url: string | null
    automatic: boolean
  } | null {
    if (!usable(c.project_id, e)) return null
    const pull = pr(c.project_id, e)
    if (
      pull &&
      (pull.url === c.target_url ||
        githubObjectLinks(pull.body).includes(c.target_url))
    )
      return {
        kind: 'pr',
        reason: pull.submitted
          ? '同项目的 GitHub PR 明确引用目标链接'
          : 'PR 已关闭且未合并，暂不认可交付',
        url: pull.url,
        automatic: true,
      }
    const known = db
      .prepare(
        "SELECT DISTINCT url FROM delivery_links WHERE task_id=? AND kind='pr' AND decision IN('auto','confirm')",
      )
      .all(c.task_id) as { url: string }[]
    const links = githubObjectLinks(e.content),
      matched =
        links.includes(c.target_url) || known.some((p) => links.includes(p.url))
    if (!matched || e.role === 'system' || e.role === 'tool') return null
    if (
      e.role === 'user' &&
      describesFeedback(e.content) &&
      links.some((l) => l.includes('/pull/'))
    ) {
      const baseline = c.baseline_event
        ? event(c.project_id, c.baseline_event)
        : undefined
      const current = eventMetadataFields(e.metadata_json).metadata,
        original = baseline
          ? eventMetadataFields(baseline.metadata_json).metadata
          : undefined
      const sameThread =
        baseline &&
        Date.parse(e.occurred_at) >= Date.parse(baseline.occurred_at) &&
        usable(c.project_id, baseline) &&
        baseline.source_id === e.source_id &&
        db
          .prepare(
            'SELECT 1 FROM feishu_connections WHERE project_id=? AND source_id=?',
          )
          .get(c.project_id, e.source_id) &&
        current?.replyToExternalId === baseline.external_id &&
        current?.author &&
        original?.author &&
        JSON.stringify(current.author) === JSON.stringify(original.author)
      return {
        kind: 'feedback',
        url: links.find((l) => l.includes('/pull/'))!,
        reason: sameThread
          ? '原承诺作者在原会话直接回复了 PR 链接'
          : '含 PR 反馈链接，请确认是否向约定对象反馈',
        automatic: !!sameThread,
      }
    }
    const change =
      e.role === 'user' && /取消|改期|延期|失败|不做|不再|撤销/.test(e.content)
    return {
      kind: 'progress',
      url: null,
      reason: change
        ? '记录提到取消、改期或失败，请核对并在事项中更新约定'
        : '同项目的明确链接；会话描述只记为执行过程',
      automatic: !change,
    }
  }
  function consider(p: string, e: Event) {
    const configs = db
      .prepare(
        "SELECT w.* FROM delivery_workflows w JOIN tasks t ON t.id=w.task_id WHERE w.project_id=? AND t.archived_at IS NULL AND t.admission='accepted' AND t.criteria_version=w.criteria_version AND t.status NOT IN('completed','cancelled')",
      )
      .all(p) as Config[]
    const matches = configs.flatMap((c) => {
      const m = classify(c, e)
      return m ? [{ c, m }] : []
    })
    const selected = db
      .prepare(
        "SELECT DISTINCT l.task_id FROM delivery_links l JOIN delivery_workflows w ON w.task_id=l.task_id JOIN source_events e ON e.id=l.event_id WHERE w.project_id=? AND e.source_id=? AND e.external_id=? AND l.decision='confirm'",
      )
      .all(p, e.source_id, e.external_id) as { task_id: string }[]
    const selectedId = selected.length === 1 ? selected[0]!.task_id : null
    for (const { c, m } of matches) {
      const old = db
        .prepare('SELECT * FROM delivery_links WHERE task_id=? AND event_id=?')
        .get(c.task_id, e.id) as Link | undefined
      if (old && ['confirm', 'reject'].includes(old.decision)) continue
      const decision =
        selectedId && selectedId !== c.task_id
          ? 'reject'
          : m.automatic && (selectedId === c.task_id || matches.length === 1)
            ? 'auto'
            : 'pending'
      const reason =
        selectedId && selectedId !== c.task_id
          ? '此来源对象已由用户关联到另一事项'
          : selectedId === c.task_id
            ? '沿用用户对该来源对象的归属选择；' + m.reason
            : matches.length > 1
              ? '同项目有多个匹配事项，请选择归属'
              : m.reason
      if (
        old?.decision === decision &&
        old.kind === m.kind &&
        old.reason === reason
      )
        continue
      db.prepare(
        'INSERT INTO delivery_links VALUES(?,?,?,?,?,?) ON CONFLICT(task_id,event_id) DO UPDATE SET kind=excluded.kind,decision=excluded.decision,reason=excluded.reason,url=excluded.url',
      ).run(c.task_id, e.id, m.kind, decision, reason, m.url)
      audit(c.task_id, e.id, decision === 'auto' ? '自动关联' : '等待确认')
    }
  }
  function replay(p: string) {
    const rows = db
      .prepare(
        'SELECT e.* FROM source_events e JOIN event_projects ep ON ep.event_id=e.id WHERE ep.project_id=? ORDER BY e.id DESC LIMIT 1001',
      )
      .all(p) as Event[]
    const limited = rows.length > 1000
    // PR links must be discovered before feedback, regardless of arrival order.
    const events = rows.slice(0, 1000).reverse()
    for (const e of events.filter((e) => pr(p, e))) consider(p, e)
    for (const e of events.filter((e) => !pr(p, e))) consider(p, e)
    if (limited)
      db.prepare(
        'UPDATE delivery_workflows SET backfill_limited=1 WHERE project_id=?',
      ).run(p)
  }
  function summary(p: string, id: string): DeliverySummary {
    const t = task(p, id),
      c = config(id)
    if (!c)
      return {
        enabled: false,
        stale: false,
        targetUrl: null,
        digest: '0'.repeat(64),
        backfillLimited: false,
        conditions: [],
        nextAction: '启用一个明确的交付场景',
        canComplete: false,
        evidence: [],
        history: [],
      }
    const rows = db
      .prepare(
        'SELECT * FROM delivery_links WHERE task_id=? ORDER BY event_id DESC LIMIT 501',
      )
      .all(id) as Link[]
    const stale =
      c.criteria_version !== t.criteriaVersion ||
      t.status === 'cancelled' ||
      !!t.archivedAt ||
      t.admission !== 'accepted'
    const evidence: DeliveryEvidence[] = rows.slice(0, 500).map((l) => {
      const e = event(p, l.event_id)
      if (!e) throw Error('DELIVERY_INVALID_EVIDENCE')
      const classified = classify(c, e)
      const available = !!classified && usable(p, e)
      return {
        eventId: e.id,
        sourceInstanceId: e.source_id,
        externalId: e.external_id,
        occurredAt: e.occurred_at,
        excerpt: e.content.slice(0, 2048),
        kind: l.kind,
        relation:
          available &&
          l.decision !== 'reject' &&
          ((l.kind === 'pr' && !pr(p, e)?.submitted) ||
            (l.kind === 'progress' &&
              e.role === 'user' &&
              /取消|改期|延期|失败|不做|不再|撤销/.test(e.content)))
            ? 'opposes'
            : available &&
                ['auto', 'confirm'].includes(l.decision) &&
                ['pr', 'feedback'].includes(l.kind)
              ? 'supports'
              : 'related',
        url: l.url,
        state: !available
          ? 'unavailable'
          : l.decision === 'reject'
            ? 'rejected'
            : l.decision === 'pending'
              ? 'pending'
              : 'linked',
        reason: !available
          ? '来源已撤回、修订或撤销授权，请重新核对'
          : classified?.kind === 'pr'
            ? classified.reason
            : l.reason,
        confirmed: l.decision === 'confirm',
      }
    })
    const prs = evidence.filter(
      (e) =>
        e.kind === 'pr' &&
        e.state === 'linked' &&
        pr(p, event(p, e.eventId)!)?.submitted,
    )
    const feedback = evidence.filter(
      (e) =>
        e.kind === 'feedback' &&
        e.state === 'linked' &&
        prs.some((pr) => pr.url === e.url),
    )
    for (const e of evidence)
      if (
        e.kind === 'feedback' &&
        !feedback.some((f) => f.eventId === e.eventId) &&
        e.relation === 'supports'
      )
        e.relation = 'related'
    const conditions = [
      {
        key: 'pr' as const,
        label: '提交目标 PR',
        met: !stale && prs.length > 0,
        eventIds: prs.map((e) => e.eventId),
      },
      {
        key: 'feedback' as const,
        label: '向约定对象反馈同一 PR 链接',
        met: !stale && feedback.length > 0,
        eventIds: feedback.map((e) => e.eventId),
      },
    ]
    const blockers = evidence.some(
      (e) =>
        e.state === 'pending' ||
        (e.state === 'linked' && e.relation === 'opposes'),
    )
    const canComplete =
      t.status !== 'completed' &&
      !stale &&
      conditions.every((c) => c.met) &&
      !blockers &&
      rows.length <= 500
    const state = {
      taskVersion: t.version,
      criteriaVersion: t.criteriaVersion,
      manualVersion: t.manualVersion,
      conditions,
      evidence,
      stale,
      canComplete,
    }
    return {
      enabled: true,
      stale,
      targetUrl: c.target_url,
      digest: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
      backfillLimited: !!c.backfill_limited || rows.length > 500,
      conditions,
      canComplete,
      nextAction: stale
        ? '事项或条件已改变，请核对原约定'
        : blockers
          ? '核对待关联或相反记录'
          : !conditions[0]!.met
            ? '提交 PR，并在描述中引用目标链接'
            : !conditions[1]!.met
              ? '向约定对象反馈此 PR 链接'
              : t.status === 'completed'
                ? '已由你确认完成'
                : '证据已齐，请核对后确认完成',
      evidence,
      history: db
        .prepare(
          'SELECT action,event_id AS eventId,recorded_at AS recordedAt FROM delivery_audit WHERE task_id=? ORDER BY id DESC LIMIT 50',
        )
        .all(id) as DeliverySummary['history'],
    }
  }
  return {
    view: db.transaction((p: string, id: string) => summary(p, id)),
    start: db.transaction((i: DeliveryExpectation & { targetUrl: string }) => {
      const t = expect(i),
        url = githubObjectUrl(i.targetUrl)
      if (
        !url ||
        config(t.id) ||
        tasks.getCriteria(i.projectId, t.id).items.length
      )
        throw Error('DELIVERY_INVALID_SETUP')
      const prId = randomUUID(),
        feedbackId = randomUUID()
      const next = tasks.replaceCriteria(
        expectation(t),
        [
          { id: prId, description: '提交目标 PR' },
          { id: feedbackId, description: '向约定对象反馈同一 PR 链接' },
        ],
        { actorId: 'local-user', reason: '用户确认 PR 提交与反馈两个交付条件' },
      )
      const baseline = createSourceAssociations(db).primaryEventId(
        i.projectId,
        t.id,
      )
      db.prepare('INSERT INTO delivery_workflows VALUES(?,?,?,?,?,?,?,0)').run(
        t.id,
        i.projectId,
        url,
        next.criteriaVersion,
        prId,
        feedbackId,
        baseline,
      )
      audit(t.id, null, '启用 PR 提交与反馈场景', 'local-user')
      replay(i.projectId)
      return summary(i.projectId, t.id)
    }),
    observe(p: string, eventId: number) {
      if (
        !db
          .prepare('SELECT 1 FROM delivery_workflows WHERE project_id=?')
          .get(p)
      )
        return
      const e = event(p, eventId)
      if (!e) return
      consider(p, e)
      if (pr(p, e)) replay(p)
    },
    associatedTaskIds(p: string, eventId: number) {
      return (
        db
          .prepare(
            "SELECT l.task_id AS id FROM delivery_links l JOIN delivery_workflows w ON w.task_id=l.task_id WHERE w.project_id=? AND l.event_id=? AND l.decision IN('auto','confirm','pending')",
          )
          .all(p, eventId) as { id: string }[]
      ).map((r) => r.id)
    },
    resolve: db.transaction(
      (
        i: DeliveryExpectation & {
          eventId: number
          decision: 'confirm' | 'reject'
          expectedDigest: string
        },
      ) => {
        expect(i)
        const s = summary(i.projectId, i.taskId)
        if (s.stale || s.digest !== i.expectedDigest)
          throw Error('VERSION_CONFLICT')
        const item = s.evidence.find((e) => e.eventId === i.eventId)
        if (!item || item.state === 'unavailable')
          throw Error('DELIVERY_INVALID_EVIDENCE')
        if (i.decision === 'confirm') {
          const conflict = db
            .prepare(
              "SELECT 1 FROM delivery_links l JOIN delivery_workflows w ON w.task_id=l.task_id WHERE w.project_id=? AND l.event_id=? AND l.task_id<>? AND l.decision='confirm'",
            )
            .get(i.projectId, i.eventId, i.taskId)
          if (conflict) throw Error('VERSION_CONFLICT')
          const others = db
            .prepare(
              "SELECT l.task_id FROM delivery_links l JOIN delivery_workflows w ON w.task_id=l.task_id WHERE w.project_id=? AND l.event_id=? AND l.task_id<>? AND l.decision<>'reject'",
            )
            .all(i.projectId, i.eventId, i.taskId) as { task_id: string }[]
          for (const other of others)
            audit(
              other.task_id,
              i.eventId,
              '用户将记录归属到另一事项',
              'local-user',
            )
          db.prepare(
            "UPDATE delivery_links SET decision='reject',reason='用户已选择另一事项' WHERE event_id=? AND task_id IN(SELECT task_id FROM delivery_workflows WHERE project_id=?) AND task_id<>?",
          ).run(i.eventId, i.projectId, i.taskId)
        }
        db.prepare(
          'UPDATE delivery_links SET decision=?,reason=? WHERE task_id=? AND event_id=?',
        ).run(
          i.decision,
          i.decision === 'confirm'
            ? '用户确认记录归属与反馈对象'
            : '用户排除此记录',
          i.taskId,
          i.eventId,
        )
        audit(
          i.taskId,
          i.eventId,
          i.decision === 'confirm' ? '人工确认关联' : '人工排除关联',
          'local-user',
        )
        replay(i.projectId)
        return summary(i.projectId, i.taskId)
      },
    ),
    complete: db.transaction(
      (i: DeliveryExpectation & { expectedDigest: string }) => {
        const t = expect(i),
          s = summary(i.projectId, i.taskId)
        if (s.digest !== i.expectedDigest || !s.canComplete)
          throw Error('VERSION_CONFLICT')
        tasks.update(
          expectation(t),
          { status: 'completed' },
          {
            actorId: 'local-user',
            reason: '用户核对 PR 与反馈链接证据后确认完成',
          },
        )
        audit(i.taskId, null, '核对交付证据后确认完成', 'local-user')
        return summary(i.projectId, i.taskId)
      },
    ),
  }
}

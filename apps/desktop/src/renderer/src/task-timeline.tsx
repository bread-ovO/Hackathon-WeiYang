import { useEffect, useRef, useState } from 'react'
import type { TimelineEntry, TimelinePage } from '@memo/contracts'
import { AppButton } from './ui'
import './task-timeline.css'

const kinds = {
  manual: '人工调整',
  rule: '本地规则整理',
  reference_conflict: '引用状态变化',
  reference_confirmation: '人工确认引用版本',
  retraction: '消息撤回影响',
} as const
const roles = {
  user: '人类发送者',
  assistant: '助手',
  tool: '工具',
  system: '系统',
} as const
const sources = {
  active: '采集已启用',
  paused: '采集已暂停',
  revoked: '授权已撤销',
  uninstalled: '插件已卸载',
  unknown: '无法确认',
} as const
const fields: Record<TimelineEntry['changes'][number]['field'], string> = {
  title: '标题',
  owner: '负责人',
  status: '事项状态',
  admission: '收录决定',
  evidenceStatus: '证据状态',
  projectId: '项目',
  archivedAt: '归档时间',
  dueAt: '截止时间',
  criteriaVersion: '条件版本',
  manualVersion: '人工版本',
  criteria: '条件',
  referenceStatus: '引用状态',
  contentDigest: '已知内容集合摘要',
  confirmedEventId: '确认使用的事件',
  evidenceRelation: '证据关系',
  evidenceValidity: '证据有效性',
}
const values: Record<string, string> = {
  todo: '待办',
  in_progress: '进行中',
  waiting: '等待反馈',
  completed: '已完成',
  cancelled: '已取消',
  candidate: '待确认',
  accepted: '已收录',
  ignored: '已忽略',
  unknown: '未知',
  partial: '部分',
  sufficient: '充分',
  conflict: '冲突',
  available: '可用',
  invalidated: '已失效',
  review_required: '待复核',
  confirmed: '已确认使用版本',
  valid: '有效',
  invalid: '失效',
  supports: '支持',
  contradicts: '反证',
  opposes: '反证',
  related: '相关',
}
const reasons: Record<string, string> = {
  explicit_commitment: '发现明确承诺，仅创建候选',
  plan_change: '检测到计划变化，需人工复核',
  candidate_limit: '候选数量达到本轮上限，需复核',
  source_revision_requires_review: '来源出现新修订，原事项保留',
  source_retracted: '来源消息明确撤回',
  source_object_retracted: '来源对象已有撤回记录',
  existing_conflict_snapshot: '迁移时发现已有内容冲突',
  known_content_changed: '已知内容集合变化，需要重新复核',
  explicit_source_retraction: '明确撤回使关联引用失效',
}
function time(value: string) {
  return new Date(value).toLocaleString()
}
function display(field: string, value: string | null) {
  if (value === null) return '未设置'
  return [
    'status',
    'admission',
    'evidenceStatus',
    'referenceStatus',
    'evidenceRelation',
    'evidenceValidity',
  ].includes(field)
    ? (values[value] ?? value)
    : value
}
function Entry({ entry }: { entry: TimelineEntry }) {
  const e = entry.evidence
  const technicalFields = [
    'contentDigest',
    'manualVersion',
    'criteriaVersion',
    'projectId',
    'confirmedEventId',
  ]
  const visibleChanges = entry.changes.filter(
    (c) => !technicalFields.includes(c.field),
  )
  const technicalChanges = entry.changes.filter((c) =>
    technicalFields.includes(c.field),
  )
  return (
    <article className="task-timeline-entry">
      <header>
        <strong>{kinds[entry.kind]}</strong>
        <span>
          {entry.timeBasis === 'migration_snapshot'
            ? '迁移时状态快照'
            : entry.timeBasis === 'event_received'
              ? '关联事件收录时间'
              : '记录时间'}
          ：{time(entry.recordedAt)}
        </span>
      </header>
      {entry.timeBasis === 'migration_snapshot' && (
        <p>此记录保留迁移时可见状态，不代表原始变化发生时间。</p>
      )}
      <p>
        执行者：
        {entry.actor.kind === 'manual'
          ? entry.actor.id === 'local-user'
            ? '本机用户'
            : '人工操作'
          : entry.actor.kind === 'rule'
            ? '本机明确承诺规则'
            : '系统'}
      </p>
      <p>
        依据：
        {entry.actor.kind !== 'manual'
          ? (reasons[entry.reason] ?? '系统记录变化，详情见技术记录。')
          : entry.reason}
      </p>
      {visibleChanges.length > 0 && (
        <dl>
          {visibleChanges.map((c, i) => (
            <div key={`${c.field}:${i}`}>
              <dt>{fields[c.field]}</dt>
              <dd>
                <span>{display(c.field, c.before)}</span>
                <span aria-label="变更为"> → </span>
                <span>{display(c.field, c.after)}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {e && (
        <details>
          <summary>
            查看关联事件 · {roles[e.role]} · 修订 {e.revision}
          </summary>
          <p>
            {e.operation === 'retract'
              ? '明确撤回记录；不会自动取消事项。'
              : '已收录消息摘录；不代表完成判定。'}
          </p>
          {e.excerpt && <blockquote>{e.excerpt}</blockquote>}
          {e.excerptTruncated && <p>长消息仅展示前 1024 个字符的摘录。</p>}
          <p>
            事件 {e.eventId} · 对象 {e.externalId} · 修订 {e.revision}
          </p>
          <p>来源 {e.sourceInstanceId}</p>
          <p>
            当前来源状态：{sources[e.sourceStatus]}（与消息撤回和引用状态独立）
          </p>
          <p>
            来源标注时间：{time(e.occurredAt)} · 收录时间：{time(e.receivedAt)}
          </p>
        </details>
      )}
      {entry.relatedEventIds.length > 1 && (
        <p>
          共关联 {entry.relatedEventIds.length} 条事件；此卡仅预览首条摘录。
        </p>
      )}
      <details className="task-timeline-technical">
        <summary>技术详情</summary>
        <p>
          记录编号：{entry.key} · 执行者标识：{entry.actor.id ?? '无'} ·
          原因代码：{entry.reason}
        </p>
        {entry.taskVersion !== null && <p>事项版本：{entry.taskVersion}</p>}
        {entry.reference && (
          <p>
            引用：{entry.reference.kind} · {entry.reference.id} · 版本{' '}
            {entry.reference.version ?? '未记录'}
          </p>
        )}
        {technicalChanges.length > 0 && (
          <dl>
            {technicalChanges.map((c, i) => (
              <div key={`${c.field}:${i}`}>
                <dt>{fields[c.field]}</dt>
                <dd>
                  {display(c.field, c.before)} → {display(c.field, c.after)}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {entry.relatedEventIds.length > 0 && (
          <p>关联事件编号：{entry.relatedEventIds.join('、')}</p>
        )}
      </details>
    </article>
  )
}
export function TaskTimeline({
  projectId,
  taskId,
}: {
  projectId: string
  taskId: string
}) {
  const [page, setPage] = useState<TimelinePage | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const active = useRef(false),
    seq = useRef(0),
    pending = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      seq.current++
    }
  }, [])
  async function load(cursor?: string) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    const request = ++seq.current
    try {
      const result = await window.memo.workspace.timeline({
        projectId,
        taskId,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      })
      if (!active.current || request !== seq.current) return
      if (result.ok)
        setPage((old) =>
          cursor && old
            ? {
                ...result.data,
                entries: [...old.entries, ...result.data.entries],
              }
            : result.data,
        )
      else
        setMessage(
          result.error === 'TIMELINE_INVALID_CURSOR'
            ? '历史分页已失效，请刷新时间线重新读取；编辑草稿保留。'
            : result.error === 'TIMELINE_CORRUPT_DATA'
              ? '时间线数据暂不可用，编辑草稿保留；请检查数据后再读取。'
              : '时间线读取失败，已显示的记录保留；请刷新后重试。',
        )
    } catch {
      if (active.current && request === seq.current)
        setMessage('时间线服务暂不可用，请稍后刷新。')
    } finally {
      if (active.current && request === seq.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <section className="task-timeline" aria-label="事项时间线">
      <div className="task-timeline-heading">
        <h3>事项时间线</h3>
        <AppButton disabled={busy} onClick={() => void load()}>
          {page ? '刷新时间线' : '查看事项时间线'}
        </AppButton>
      </div>
      <p>
        记录人工调整、规则整理与引用变化。分页查看完整记录；刷新不会覆盖未保存的编辑。历史变化不等同于当前有效依据。
      </p>
      {message && <p role="alert">{message}</p>}
      {busy && <p role="status">正在读取时间线…</p>}
      {page && page.entries.length === 0 && <p>暂无可展示的事项记录。</p>}
      {page?.entries.map((entry) => (
        <Entry key={entry.key} entry={entry} />
      ))}
      {page?.nextCursor && (
        <AppButton disabled={busy} onClick={() => void load(page.nextCursor!)}>
          加载更多变化
        </AppButton>
      )}
      {page && !page.nextCursor && page.entries.length > 0 && (
        <p>本次读取的历史已全部展示；查看新变化请刷新。</p>
      )}
    </section>
  )
}

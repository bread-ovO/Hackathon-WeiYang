import { useEffect, useRef, useState } from 'react'
import type {
  CoreReply,
  IdentityMapping,
  ProjectSourceEvent,
  SourceBinding,
  WorkspaceTask,
} from '@memo/contracts'
import { AppButton, AppInput } from './ui'
import './source-associations.css'
const statuses = {
  active: '已授权',
  paused: '已暂停',
  revoked: '已撤权',
  uninstalled: '已卸载',
  unknown: '授权未知',
} as const
const when = (value: string) => new Date(value).toLocaleString()
const author = (event: ProjectSourceEvent) =>
  event.author
    ? `${event.author.namespace} · ${event.author.subjectId}`
    : '发送者身份未知'
export function SourceAssociations({
  task,
  busy,
  onChanged,
}: {
  task: WorkspaceTask
  busy: boolean
  onChanged: () => void
}) {
  const [events, setEvents] = useState<ProjectSourceEvent[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [bindings, setBindings] = useState<SourceBinding[]>([]),
    [mappings, setMappings] = useState<IdentityMapping[]>([])
  const [selected, setSelected] = useState<ProjectSourceEvent | null>(null),
    [left, setLeft] = useState<ProjectSourceEvent | null>(null),
    [right, setRight] = useState<ProjectSourceEvent | null>(null)
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pending, setPending] = useState(false),
    [opened, setOpened] = useState(false),
    [revoke, setRevoke] = useState<{
      kind: 'binding' | 'mapping'
      id: string
      version: number
    } | null>(null)
  const epoch = useRef(0),
    flight = useRef(false)
  const scope = { projectId: task.projectId!, taskId: task.id }
  const expectation = {
    expectedVersion: task.version,
    expectedCriteriaVersion: task.criteriaVersion,
    expectedManualVersion: task.manualVersion,
  }
  async function execute<T>(
    request: () => Promise<CoreReply<T>>,
    accept: (data: T) => void,
  ) {
    if (flight.current || busy || !task.projectId) return
    flight.current = true
    setPending(true)
    setError('')
    setNotice('')
    const generation = epoch.current
    try {
      const reply = await request()
      if (generation !== epoch.current) return
      if (reply.ok) accept(reply.data)
      else
        setError(
          reply.error === 'ASSOCIATION_CONFLICT' ||
            reply.error === 'VERSION_CONFLICT'
            ? '关联或事项版本已变化，未提交。请刷新后核实。'
            : reply.error === 'ASSOCIATION_UNAVAILABLE'
              ? '所选记录、来源或身份不可用，未提交。'
              : reply.error === 'PLAN_CHANGE_NOT_APPLICABLE'
                ? '该记录没有可应用的明确改期，或当前关联不满足要求。'
                : reply.error === 'ASSOCIATION_LIMIT_EXCEEDED'
                  ? '已达到关联数量上限。'
                  : '操作未完成，请刷新后重试。',
        )
    } catch {
      if (generation === epoch.current)
        setError('本地核心暂不可用，请刷新核实结果。')
    } finally {
      if (generation === epoch.current) {
        flight.current = false
        setPending(false)
      }
    }
  }
  async function refresh() {
    await execute(
      async () => {
        const [b, m] = await Promise.all([
          window.memo.workspace.sourceBindings(scope),
          window.memo.workspace.identityMappings(scope),
        ])
        if (!b.ok) return b
        if (!m.ok) return m
        return {
          ok: true as const,
          data: { bindings: b.data.bindings, mappings: m.data.mappings },
        }
      },
      (data) => {
        setBindings(data.bindings)
        setMappings(data.mappings)
        onChanged()
      },
    )
  }
  useEffect(() => {
    epoch.current++
    flight.current = false
    void refresh()
    return () => {
      epoch.current++
    }
  }, [task.id, task.projectId])
  function load(after?: string) {
    void execute(
      () =>
        window.memo.workspace.sourceEvents({
          projectId: scope.projectId,
          limit: 20,
          ...(after ? { cursor: after } : {}),
        }),
      (data) => {
        setEvents((old) =>
          after
            ? [
                ...old,
                ...data.events.filter((e) => !old.some((x) => x.id === e.id)),
              ]
            : data.events,
        )
        setCursor(data.nextCursor)
        setOpened(true)
      },
    )
  }
  function bindingFor(event: ProjectSourceEvent | null) {
    return event
      ? bindings.find(
          (b) =>
            b.active &&
            b.sourceInstanceId === event.sourceInstanceId &&
            b.externalId === event.externalId,
        )
      : undefined
  }
  const leftBinding = bindingFor(left),
    rightBinding = bindingFor(right)
  const key = (a: {
    sourceInstanceId: string
    namespace: string
    subjectId: string
  }) => JSON.stringify([a.sourceInstanceId, a.namespace, a.subjectId])
  const pair =
    left?.author && right?.author
      ? mappings.find(
          (m) =>
            (key(m.left) === key(left.author!) &&
              key(m.right) === key(right.author!)) ||
            (key(m.left) === key(right.author!) &&
              key(m.right) === key(left.author!)),
        )
      : undefined
  const disabled = pending || busy
  return (
    <details className="source-associations">
      <summary>来源关联与身份确认</summary>
      <section aria-label="来源关联与身份确认">
        <p>
          关联具体来源对象，不会新增完成证据或修改事项。跨来源身份只采用你确认的直接对应关系，不按姓名合并。
        </p>
        <div className="association-actions">
          <AppButton disabled={disabled} onClick={() => void refresh()}>
            刷新来源关联
          </AppButton>
          <AppButton disabled={disabled} onClick={() => load()}>
            选择已收录来源记录
          </AppButton>
        </div>
        {opened && (
          <div className="association-picker" aria-label="项目来源记录">
            <p>仅展示当前项目已收录的记录。先选择记录，再执行下方操作。</p>
            {events.map((e) => (
              <label className="association-event" key={e.id}>
                <input
                  type="radio"
                  name={`association-event-${task.id}`}
                  checked={selected?.id === e.id}
                  onChange={() => setSelected(e)}
                  aria-label={`选择记录 ${e.excerpt}`}
                />
                <span>
                  <strong>{e.excerpt || '（无正文）'}</strong>
                  {e.excerptTruncated && ' · 摘录已截断'}
                  <span>
                    {when(e.occurredAt)} ·{' '}
                    {
                      {
                        user: '用户',
                        assistant: '助手',
                        tool: '工具',
                        system: '系统',
                      }[e.role]
                    }{' '}
                    · {statuses[e.sourceStatus]}
                    {e.operation === 'retract' ? ' · 已撤回' : ''}
                  </span>
                  <span>{author(e)}</span>
                </span>
              </label>
            ))}
            {!events.length && <p>此项目尚无已收录记录。</p>}
            {cursor && (
              <AppButton disabled={disabled} onClick={() => load(cursor)}>
                更多来源记录
              </AppButton>
            )}
          </div>
        )}
        {selected && (
          <div className="association-selection">
            <h4>当前选择</h4>
            <blockquote>{selected.excerpt}</blockquote>
            <p>
              {author(selected)} · {when(selected.occurredAt)}
            </p>
            <details>
              <summary>查看来源对象标识</summary>
              <p>
                来源 {selected.sourceInstanceId} · 对象 {selected.externalId} ·
                修订 {selected.revision}
              </p>
            </details>
            <div className="association-actions">
              <AppButton
                disabled={
                  disabled ||
                  selected.sourceStatus !== 'active' ||
                  selected.operation === 'retract'
                }
                onClick={() => {
                  setLeft(selected)
                  setRevoke(null)
                }}
              >
                作为身份左端
              </AppButton>
              <AppButton
                disabled={
                  disabled ||
                  selected.sourceStatus !== 'active' ||
                  selected.operation === 'retract'
                }
                onClick={() => {
                  setRight(selected)
                  setRevoke(null)
                }}
              >
                作为身份右端
              </AppButton>
            </div>
          </div>
        )}
        <label className="association-reason">
          操作理由
          <AppInput
            aria-label="来源关联操作理由"
            value={reason}
            maxLength={512}
            onChange={(e) => setReason(e.target.value)}
            placeholder="说明关联、身份确认或重新评估的依据"
          />
        </label>
        {selected && (
          <div className="association-actions">
            <AppButton
              disabled={
                disabled ||
                !reason.trim() ||
                selected.sourceStatus !== 'active' ||
                selected.operation === 'retract'
              }
              onClick={() =>
                void execute(
                  () =>
                    window.memo.workspace.bindSourceObject({
                      ...scope,
                      eventId: selected.id,
                      expectedTaskVersion: task.version,
                      expectedCriteriaVersion: task.criteriaVersion,
                      expectedManualVersion: task.manualVersion,
                      reason: reason.trim(),
                    }),
                  (data) => {
                    setBindings(data.bindings)
                    setNotice('已关联此来源对象，事项字段保持不变。')
                    onChanged()
                  },
                )
              }
            >
              确认关联当前事项
            </AppButton>
            <AppButton
              disabled={disabled || !reason.trim()}
              onClick={() =>
                void execute(
                  () =>
                    window.memo.workspace.reevaluatePlanChange({
                      ...scope,
                      eventId: selected.id,
                      ...expectation,
                      reason: reason.trim(),
                    }),
                  () => {
                    setNotice(
                      '已重新评估所选记录，请查看计划变更建议。未扫描其它历史记录。',
                    )
                    onChanged()
                  },
                )
              }
            >
              重新评估所选记录
            </AppButton>
          </div>
        )}
        {(left || right) && (
          <div className="association-pair">
            <h4>确认两个发送者属于同一人</h4>
            <p>左端：{left ? author(left) : '尚未选择'}</p>
            <p>右端：{right ? author(right) : '尚未选择'}</p>
            <p>
              两端必须先关联到本事项；此直接映射在当前项目内共享，不能代替具体事项关联。
            </p>
            <AppButton
              disabled={
                disabled ||
                !reason.trim() ||
                !left?.author ||
                !right?.author ||
                !leftBinding ||
                !rightBinding ||
                left.id === right.id ||
                pair?.active
              }
              onClick={() => {
                if (!left || !right || !leftBinding || !rightBinding) return
                void execute(
                  () =>
                    window.memo.workspace.confirmIdentityMapping({
                      ...scope,
                      leftEventId: left.id,
                      rightEventId: right.id,
                      expectedLeftBindingVersion: leftBinding.version,
                      expectedRightBindingVersion: rightBinding.version,
                      expectedMappingVersion: pair?.version ?? 0,
                      reason: reason.trim(),
                    }),
                  (data) => {
                    setMappings(data.mappings)
                    setNotice(
                      '已确认项目内直接身份映射。可选择具体计划记录重新评估。',
                    )
                    onChanged()
                  },
                )
              }}
            >
              确认两端身份映射
            </AppButton>
          </div>
        )}
        <h4>已关联对象</h4>
        {!bindings.length && <p>当前事项没有来源对象关联。</p>}
        {bindings.map((b) => (
          <div className="association-record" key={b.id}>
            <p>
              {b.primary ? '原始计划基准 · ' : ''}
              {b.origin === 'rule' ? '规则关联' : '人工关联'} ·{' '}
              {b.active ? '有效' : '已撤销'}
            </p>
            <details>
              <summary>来源对象详情</summary>
              <p>
                {b.sourceInstanceId} · {b.externalId}
              </p>
            </details>
            {b.active && b.origin === 'manual' && (
              <AppButton
                disabled={disabled}
                onClick={() =>
                  setRevoke({ kind: 'binding', id: b.id, version: b.version })
                }
              >
                撤销此来源关联
              </AppButton>
            )}
          </div>
        ))}
        <h4>直接身份映射</h4>
        {!mappings.length && <p>尚未确认身份映射。</p>}
        {mappings.map((m) => (
          <div className="association-record" key={m.id}>
            <p>
              {m.left.namespace} · {m.left.subjectId} ↔ {m.right.namespace} ·{' '}
              {m.right.subjectId}
            </p>
            <p>{m.active ? '映射有效' : '映射已撤销'}</p>
            {m.active && (
              <AppButton
                disabled={disabled}
                onClick={() =>
                  setRevoke({ kind: 'mapping', id: m.id, version: m.version })
                }
              >
                撤销此身份映射
              </AppButton>
            )}
          </div>
        ))}
        {revoke && (
          <div className="association-pair">
            <p>
              {revoke.kind === 'mapping'
                ? '撤销会影响当前项目所有依赖此直接身份映射的事项。'
                : '撤销将阻止依赖此来源关联的后续建议。'}{' '}
              已人工应用的截止时间保持不变。
            </p>
            <div className="association-actions">
              <AppButton
                disabled={disabled || !reason.trim()}
                onClick={() => {
                  if (revoke.kind === 'binding')
                    void execute(
                      () =>
                        window.memo.workspace.revokeSourceBinding({
                          ...scope,
                          id: revoke.id,
                          expectedVersion: revoke.version,
                          reason: reason.trim(),
                        }),
                      (data) => {
                        setBindings(data.bindings)
                        setRevoke(null)
                        setNotice('已撤销来源关联。')
                        onChanged()
                      },
                    )
                  else
                    void execute(
                      () =>
                        window.memo.workspace.revokeIdentityMapping({
                          ...scope,
                          id: revoke.id,
                          expectedVersion: revoke.version,
                          reason: reason.trim(),
                        }),
                      (data) => {
                        setMappings(data.mappings)
                        setRevoke(null)
                        setNotice('已撤销直接身份映射。')
                        onChanged()
                      },
                    )
                }}
              >
                确认撤销
              </AppButton>
              <AppButton disabled={disabled} onClick={() => setRevoke(null)}>
                保留关联
              </AppButton>
            </div>
          </div>
        )}
        {pending && <p role="status">正在处理关联…</p>}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
      </section>
    </details>
  )
}

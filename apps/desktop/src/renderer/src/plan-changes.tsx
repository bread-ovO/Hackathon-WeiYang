import { useEffect, useRef, useState } from 'react'
import type { PlanChangeProposal, WorkspaceTask } from '@memo/contracts'
import { AppButton, AppInput } from './ui'
import './plan-changes.css'
const guards = {
  ready: '可人工确认',
  association_changed: '来源关联已撤销或变化，请核实后重新评估',
  mapping_changed: '身份映射已撤销或变化，不能直接应用',
  identity_unknown: '发送者身份尚未核实，不能应用该建议',
  identity_mismatch: '发送者与原始承诺不同，需要进一步核实关联',
  reference_invalidated:
    '依据存在不同版本，此建议不能直接应用，请核实后手动调整',
  unknown_revision_order: '来源修订顺序不可确认，请先核实原始计划',
  late_occurrence: '存在更晚的来源计划，此建议不能直接应用',
  simultaneous_conflict: '同一来源时间存在冲突，请先核实计划',
  source_unavailable: '来源当前未启用或授权不可确认',
  retracted: '来源记录已撤回，不能应用',
  task_changed: '事项已被修改，此建议已过期',
} as const
const sourceLabels = {
  active: '已授权',
  paused: '采集已暂停',
  revoked: '授权已撤销',
  uninstalled: '插件已卸载',
  unknown: '授权状态未知',
} as const
const time = (value: string | null) =>
  value ? new Date(value).toLocaleString() : '未设置'
export function PlanChanges({
  task,
  busy,
  onApplied,
  refreshVersion = 0,
}: {
  task: WorkspaceTask
  busy: boolean
  refreshVersion?: number
  onApplied: (task: WorkspaceTask) => void
}) {
  const [rows, setRows] = useState<PlanChangeProposal[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<number | null>(null),
    [reason, setReason] = useState(''),
    [notice, setNotice] = useState('')
  const lastRefresh = useRef(0)
  const epoch = useRef(0),
    flight = useRef(false)
  async function load(after?: string) {
    if (flight.current || !task.projectId) return
    flight.current = true
    setPending(true)
    setError('')
    const generation = epoch.current
    try {
      const reply = await window.memo.workspace.planChanges({
        projectId: task.projectId,
        taskId: task.id,
        limit: 20,
        ...(after ? { cursor: after } : {}),
      })
      if (generation !== epoch.current) return
      if (!reply.ok) {
        setError('计划建议读取失败，请重试。')
        return
      }
      setRows((old) =>
        after
          ? [
              ...old,
              ...reply.data.proposals.filter(
                (p) => !old.some((r) => r.id === p.id),
              ),
            ]
          : reply.data.proposals,
      )
      setCursor(reply.data.nextCursor)
      if (!after)
        setSelected((old) =>
          reply.data.proposals.some(
            (p) => p.id === old && p.status === 'pending',
          )
            ? old
            : null,
        )
    } catch {
      if (generation === epoch.current) setError('本地核心暂不可用。')
    } finally {
      if (generation === epoch.current) {
        flight.current = false
        setPending(false)
      }
    }
  }
  useEffect(() => {
    epoch.current++
    flight.current = false
    setRows([])
    setCursor(null)
    setSelected(null)
    setNotice('')
    setReason('')
    setError('')
    void load()
    return () => {
      epoch.current++
    }
  }, [task.id, task.projectId])
  useEffect(() => {
    if (refreshVersion > lastRefresh.current && !flight.current) {
      lastRefresh.current = refreshVersion
      void load()
    }
  }, [refreshVersion, pending])
  async function confirm(proposal: PlanChangeProposal) {
    if (flight.current || busy || !task.projectId || !reason.trim()) return
    flight.current = true
    setPending(true)
    setError('')
    const generation = epoch.current
    try {
      const reply = await window.memo.workspace.confirmPlanChange({
        projectId: task.projectId,
        taskId: task.id,
        proposalId: proposal.id,
        expectedAssessmentVersion: proposal.assessmentVersion,
        expectedVersion: proposal.taskVersion,
        expectedCriteriaVersion: proposal.criteriaVersion,
        expectedManualVersion: proposal.manualVersion,
        reason: reason.trim(),
      })
      if (generation !== epoch.current) return
      if (!reply.ok) {
        setError(
          reply.error === 'VERSION_CONFLICT' ||
            reply.error === 'PLAN_CHANGE_NOT_APPLICABLE'
            ? '事项或来源已变化，未应用。请刷新建议后重新核实。'
            : '改期未成功，请重试。',
        )
        setSelected(null)
        return
      }
      setRows((old) =>
        old.map((p) =>
          p.id === proposal.id ? { ...p, status: 'applied' } : p,
        ),
      )
      setSelected(null)
      setReason('')
      setNotice('已更新事项截止时间。未保存的标题、时间和条件草稿仍保留。')
      onApplied(reply.data.task)
    } catch {
      if (generation === epoch.current)
        setError('结果暂不可确认，请刷新建议核实后再操作。')
    } finally {
      if (generation === epoch.current) {
        flight.current = false
        setPending(false)
      }
    }
  }
  return (
    <section className="plan-changes" aria-label="计划变更建议">
      <div className="plan-change-heading">
        <h3>计划变更建议</h3>
        <AppButton disabled={pending || busy} onClick={() => void load()}>
          刷新计划建议
        </AppButton>
      </div>
      <p>
        仅使用已明确关联的来源对象与经确认的直接身份映射。改期需要你确认；不会按标题或记录到达顺序覆盖事项。
      </p>
      <p>
        当前已保存截止时间：<strong>{time(task.dueAt)}</strong>
      </p>
      {rows.map((p) => (
        <article key={p.id} aria-label={`改期建议 ${p.id}`}>
          <h4>建议改到 {time(p.dueAt)}</h4>
          <blockquote>{p.quote}</blockquote>
          <p>
            来源标注时间：{time(p.occurredAt)} · 收录时间：{time(p.receivedAt)}
          </p>
          <p>
            {
              { user: '用户', assistant: '助手', tool: '工具', system: '系统' }[
                p.role
              ]
            }{' '}
            · {sourceLabels[p.sourceStatus]}
          </p>
          <details className="plan-change-source">
            <summary>来源记录详情</summary>
            <p>
              来源 {p.sourceInstanceId} · 对象 {p.externalId} · 修订{' '}
              {p.revision}
            </p>
          </details>
          <p>{p.status === 'applied' ? '已人工应用' : guards[p.guard]}</p>
          {p.status === 'pending' &&
            p.guard === 'ready' &&
            (selected === p.id ? (
              <div className="plan-change-confirm">
                <p>
                  将已保存的截止时间从 {time(task.dueAt)} 改为 {time(p.dueAt)}
                  。标题、业务状态和完成条件保持原值。
                </p>
                <AppInput
                  aria-label="改期确认理由"
                  maxLength={512}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="填写你确认该计划的理由"
                />
                <div className="plan-change-heading">
                  <AppButton
                    disabled={pending || busy || !reason.trim()}
                    onClick={() => void confirm(p)}
                  >
                    确认应用改期
                  </AppButton>
                  <AppButton
                    disabled={pending}
                    onClick={() => setSelected(null)}
                  >
                    暂不应用
                  </AppButton>
                </div>
              </div>
            ) : (
              <AppButton
                disabled={pending || busy}
                onClick={() => {
                  setSelected(p.id)
                  setReason('')
                }}
              >
                核实并改期
              </AppButton>
            ))}
        </article>
      ))}
      {!rows.length && !pending && !error && (
        <p>
          暂无已关联的明确改期建议。仅识别包含时区的明确表达，例如“截止时间改为
          2026-09-20T18:00:00+08:00”。可在来源关联区选择已收录记录并重新评估。
        </p>
      )}
      {cursor && (
        <AppButton disabled={pending || busy} onClick={() => void load(cursor)}>
          更多计划建议
        </AppButton>
      )}
      {pending && <p role="status">正在处理计划建议…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}

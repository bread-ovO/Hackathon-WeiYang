import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoreReply, DeliverySummary, WorkspaceTask } from '@memo/contracts'
import {
  CheckCircle,
  Circle,
  ArrowRight,
  WarningCircle,
} from '@phosphor-icons/react'
import { AppButton, AppInput } from './ui'
import { Disclosure } from './ui/disclosure'
import './delivery-panel.css'
export function DeliveryPanel({
  task,
  disabled,
  onUpdated,
  showSetup = true,
  onEnabledChange,
}: {
  task: WorkspaceTask
  disabled: boolean
  onUpdated: (task: WorkspaceTask) => void
  showSetup?: boolean
  onEnabledChange?: (enabled: boolean) => void
}) {
  const [data, setData] = useState<DeliverySummary | null>(null),
    [url, setUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const generation = useRef(0),
    working = useRef(false)
  useEffect(() => { onEnabledChange?.(data?.enabled ?? false) }, [data?.enabled, onEnabledChange])
  const load = useCallback(async () => {
    if (!task.projectId || working.current) return
    const n = ++generation.current
    try {
      const r = await window.memo.workspace.delivery(task.projectId, task.id)
      if (n !== generation.current) return
      if (r.ok) {
        setData(r.data)
        setError('')
      } else setError('进展暂时无法读取，请重试')
    } catch {
      if (n === generation.current) setError('进展暂时无法读取，请重试')
    }
  }, [task.id, task.version])
  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      if (!document.hidden) void load()
    }, 3000)
    return () => {
      generation.current++
      clearInterval(timer)
    }
  }, [load])
  const expected = {
    projectId: task.projectId!,
    taskId: task.id,
    expectedTaskVersion: task.version,
    expectedCriteriaVersion: task.criteriaVersion,
    expectedManualVersion: task.manualVersion,
  }
  async function run(work: () => Promise<CoreReply<DeliverySummary>>) {
    if (working.current) return
    working.current = true
    generation.current++
    setBusy(true)
    setError('')
    try {
      const r = await work()
      if (r.ok) {
        setData(r.data)
        const detail = await window.memo.workspace.detail(
          task.projectId!,
          task.id,
        )
        if (detail.ok) onUpdated(detail.data.task)
      } else
        setError(
          r.error === 'VERSION_CONFLICT'
            ? '记录已变化，请刷新进展后再确认。'
            : '无法应用：请先收录事项，并确认没有已有的自定义条件。',
        )
    } catch {
      setError('操作结果需要确认，请刷新进展。')
    } finally {
      working.current = false
      setBusy(false)
    }
  }
  const locked =
    disabled ||
    busy ||
    task.admission !== 'accepted' ||
    !!task.archivedAt ||
    task.status === 'cancelled' ||
    task.status === 'completed'
  if (!task.projectId) return null
  if (!showSetup && !data?.enabled && !error) return null
  return (
    <section className="delivery-panel" aria-label="交付进展" data-setup={!!data && !data.enabled}>
      {error && (
        <p role="alert">
          {error}
          <AppButton size="xs" disabled={busy} onClick={() => void load()}>
            刷新进展
          </AppButton>
        </p>
      )}
      {!data ? (
        <p>正在读取进展…</p>
      ) : !data.enabled ? (
        <Disclosure
          title="跟进 PR 提交与反馈"
          description="把聊天、执行记录和 PR 接到这件事上"
          open={showSetup}
        >
          <p>
            确认本次约定包含“提交
            PR”和“向约定对象反馈同一链接”。只适用于尚未设置完成条件的事项；不会额外要求测试、合并或部署。
          </p>
          <label>
            目标 Issue 或 PR 链接
            <AppInput
              aria-label="交付目标链接"
              placeholder="https://github.com/owner/repo/issues/1"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={locked}
            />
          </label>
          {task.admission !== 'accepted' && (
            <p>先确认收录此事项，再启用交付跟进。</p>
          )}
          <AppButton
            variant="primary"
            disabled={locked || !url.trim()}
            onClick={() =>
              void run(() =>
                window.memo.workspace.startDelivery({
                  ...expected,
                  targetUrl: url.trim(),
                }),
              )
            }
          >
            确认两个条件并开始跟进
          </AppButton>
        </Disclosure>
      ) : (
        <>
          <header>
            <span>交付进展</span>
            <strong>
              {data.stale
                ? '需要核对'
                : `${data.conditions.filter((c) => c.met).length} / ${data.conditions.length}`}
            </strong>
          </header>
          <ul className="delivery-conditions">
            {data.conditions.map((c) => (
              <li key={c.key} data-met={c.met}>
                {c.met ? (
                  <CheckCircle size={20} weight="fill" aria-hidden />
                ) : (
                  <Circle size={20} aria-hidden />
                )}
                <span>{c.label}</span>
                <small>{c.met ? '已有依据' : '尚未找到依据'}</small>
              </li>
            ))}
          </ul>
          <p className="delivery-next">
            <ArrowRight size={16} aria-hidden />
            {data.nextAction}
          </p>
          {data.canComplete && task.status !== 'completed' && (
            <AppButton
              variant="primary"
              disabled={locked}
              onClick={() =>
                void run(() =>
                  window.memo.workspace.completeDelivery({
                    ...expected,
                    expectedDigest: data.digest,
                  }),
                )
              }
            >
              核对后确认完成
            </AppButton>
          )}
          {data.backfillLimited && (
            <p>
              <WarningCircle size={16} aria-hidden />
              历史扫描达到上限，当前结果不代表完整历史。
            </p>
          )}
          {data.evidence
            .filter(
              (e) =>
                e.state === 'pending' ||
                (e.state === 'linked' && e.relation === 'opposes'),
            )
            .slice(0, 1)
            .map((e) => (
              <div key={e.eventId} className="delivery-pending">
                <strong>
                  {e.relation === 'opposes'
                    ? '这条记录需要核对原约定'
                    : e.kind === 'feedback'
                      ? '这条消息是否完成了反馈？'
                      : '这条记录属于当前事项吗？'}
                </strong>
                <p>{e.reason}</p>
                <blockquote>{e.excerpt.slice(0, 240)}</blockquote>
                <div>
                  {e.relation !== 'opposes' && (
                    <AppButton
                      disabled={locked || data.stale}
                      onClick={() =>
                        void run(() =>
                          window.memo.workspace.resolveDelivery({
                            ...expected,
                            eventId: e.eventId,
                            decision: 'confirm',
                            expectedDigest: data.digest,
                          }),
                        )
                      }
                    >
                      {e.kind === 'feedback'
                        ? '确认已向约定对象反馈'
                        : '确认属于此事项'}
                    </AppButton>
                  )}
                  <AppButton
                    disabled={locked || data.stale}
                    onClick={() =>
                      void run(() =>
                        window.memo.workspace.resolveDelivery({
                          ...expected,
                          eventId: e.eventId,
                          decision: 'reject',
                          expectedDigest: data.digest,
                        }),
                      )
                    }
                  >
                    排除这条记录
                  </AppButton>
                </div>
              </div>
            ))}
          <Disclosure title={`查看关联依据（${data.evidence.length}）`}>
            <p className="delivery-target">目标：{data.targetUrl}</p>
            {data.evidence.map((e) => (
              <details key={e.eventId}>
                <summary>
                  {e.kind === 'pr'
                    ? 'GitHub PR'
                    : e.kind === 'feedback'
                      ? '反馈记录'
                      : '执行记录'}{' '}
                  ·{' '}
                  {
                    {
                      linked: '已关联',
                      pending: '待确认',
                      rejected: '已排除',
                      unavailable: '依据不可用',
                    }[e.state]
                  }
                </summary>
                <p>
                  {
                    {
                      supports: '支持当前条件',
                      opposes: '相反记录',
                      related: '相关过程',
                    }[e.relation]
                  }{' '}
                  · {e.reason}
                </p>
                <p>
                  {new Date(e.occurredAt).toLocaleString()} ·{' '}
                  {e.confirmed ? '人工确认' : '本地链接规则'}
                </p>
                <blockquote>{e.excerpt}</blockquote>
              </details>
            ))}
            {data.evidence.length === 0 && (
              <p>
                尚未发现匹配记录。请在执行会话或 PR
                描述里引用目标链接，并确认来源已连接。
              </p>
            )}
            <details>
              <summary>关联变化记录</summary>
              {data.history.map((h, i) => (
                <p key={i}>
                  {h.action} · {new Date(h.recordedAt).toLocaleString()}
                </p>
              ))}
            </details>
          </Disclosure>
        </>
      )}
    </section>
  )
}

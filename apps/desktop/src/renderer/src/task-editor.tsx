import './candidate-provenance.css'
import { useEffect, useRef, useState } from 'react'
import type {
  CoreRequest,
  WorkspaceTask,
  CandidateProvenance,
} from '@memo/contracts'
import { AppButton, AppInput } from './ui'
export const taskLabels = {
  todo: '待办',
  in_progress: '进行中',
  waiting: '等待反馈',
  completed: '已完成',
  cancelled: '已取消',
} as const
type Patch = Extract<CoreRequest, { method: 'workspace.updateTask' }>['patch']
function localDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}
export function TaskEditor({
  task,
  busy,
  update,
  replace,
  close,
}: {
  task: WorkspaceTask
  busy: boolean
  update: (patch: Patch) => Promise<void>
  replace: (
    items: { id: string; description: string; originEventId?: number }[],
  ) => Promise<void>
  close: () => void
}) {
  const [title, setTitle] = useState(task.title),
    [due, setDue] = useState(localDate(task.dueAt))
  const [version, setVersion] = useState(task.criteriaVersion),
    [items, setItems] = useState<
      { id: string; description: string; originEventId?: number }[]
    >([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  const [provenance, setProvenance] = useState<CandidateProvenance[]>([])
  const generation = useRef(0)
  useEffect(() => {
    setTitle(task.title)
    setDue(localDate(task.dueAt))
    setVersion(task.criteriaVersion)
  }, [task.id, task.version])
  useEffect(() => {
    const seq = ++generation.current
    if (!task.projectId) return
    setLoading(true)
    setProvenance([])
    setError('')
    window.memo.workspace
      .detail(task.projectId, task.id, version)
      .then((r) => {
        if (seq !== generation.current) return
        if (r.ok) {
          setItems(r.data.criteria.items.map((x) => ({ ...x })))
          setProvenance(r.data.provenance ?? [])
        } else setError('条件读取失败，请刷新事项。')
      })
      .catch(() => {
        if (seq === generation.current) setError('本地核心暂不可用。')
      })
      .finally(() => {
        if (seq === generation.current) setLoading(false)
      })
    return () => {
      generation.current++
    }
  }, [task.id, task.version, version])
  const readonly = version !== task.criteriaVersion
  return (
    <section className="detail" aria-label="事项详情">
      <div className="detail-top">
        <AppButton onClick={close}>关闭详情</AppButton>
      </div>
      <div className="real-editor">
        <h2>{task.title}</h2>
        <p>业务状态：{taskLabels[task.status]}</p>
        <p>
          证据：
          {
            {
              unknown: '尚未核验',
              partial: '部分充分',
              sufficient: '充分',
              conflict: '存在冲突',
            }[task.evidenceStatus]
          }
        </p>
        {!loading && provenance.length > 0 && (
          <section className="candidate-provenance" aria-label="候选来源依据">
            <h3>候选来源依据</h3>
            <p>
              由本地有限规则整理。引用用于说明候选来源，不代表交付已经完成。
            </p>
            {provenance.map((item) => (
              <details key={`${item.eventId}:${item.quoteStart}`}>
                <summary>
                  {item.quoteKind === 'revision_excerpt'
                    ? '查看待复核修订摘录'
                    : '查看原文引用'}{' '}
                  · 修订 {item.revision}
                </summary>
                <blockquote>{item.quote}</blockquote>
                {item.quoteKind === 'revision_excerpt' && (
                  <p>这是后续修订的摘录，尚未应用到事项，也不作为完成证据。</p>
                )}
                {item.revisionStatus === 'review_required' && (
                  <p>来源有后续修订，请复核此候选；原引用仍保留。</p>
                )}
                {item.sourceStatus !== 'active' && (
                  <p>
                    {
                      (
                        {
                          revoked: '来源已停用，原引用仍保留。',
                          uninstalled: '来源插件已卸载，原引用仍保留。',
                          unknown: '来源授权状态不可确认，引用需复核。',
                        } as const
                      )[item.sourceStatus]
                    }
                  </p>
                )}
                <p>整理时间：{new Date(item.createdAt).toLocaleString()}</p>
              </details>
            ))}
          </section>
        )}
        {task.projectId ? (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void update({ title: title.trim() })
              }}
            >
              <AppInput
                aria-label="编辑事项标题"
                value={title}
                maxLength={512}
                onChange={(e) => setTitle(e.target.value)}
              />
              <AppButton
                type="submit"
                className="secondary"
                disabled={busy || !title.trim()}
              >
                保存标题
              </AppButton>
            </form>
            <label>
              手动状态
              <select
                aria-label="手动状态"
                disabled={busy}
                value={task.status}
                onChange={(e) =>
                  void update({
                    status: e.target.value as WorkspaceTask['status'],
                  })
                }
              >
                {Object.entries(taskLabels).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                const date = due ? new Date(due) : null
                if (
                  date &&
                  (!Number.isFinite(date.getTime()) ||
                    localDate(date.toISOString()) !== due)
                ) {
                  setError('该本地时间不存在或无效，请选择明确时间。')
                  return
                }
                void update({ dueAt: date?.toISOString() ?? null })
              }}
            >
              <label htmlFor="task-due">截止时间（本机时区）</label>
              <AppInput
                id="task-due"
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
              <AppButton type="submit" className="secondary" disabled={busy}>
                保存截止时间
              </AppButton>
              <AppButton
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setDue('')
                  void update({ dueAt: null })
                }}
              >
                清除截止时间
              </AppButton>
            </form>
            <label>
              收录决定
              <select
                aria-label="收录决定"
                value={task.admission}
                disabled={busy}
                onChange={(e) =>
                  void update({
                    admission: e.target.value as
                      | 'candidate'
                      | 'accepted'
                      | 'ignored',
                  })
                }
              >
                <option value="candidate">待确认</option>
                <option value="accepted">已收录</option>
                <option value="ignored">已忽略</option>
              </select>
            </label>
            <div className="criteria-editor">
              <label>
                完成条件
                <select
                  aria-label="条件版本"
                  value={version}
                  disabled={loading}
                  onChange={(e) => setVersion(Number(e.target.value))}
                >
                  {Array.from({ length: task.criteriaVersion + 1 }, (_, i) => (
                    <option key={i} value={i}>
                      版本 {i}
                      {i === task.criteriaVersion ? '（当前）' : '（历史）'}
                    </option>
                  ))}
                </select>
              </label>
              {error ? (
                <p role="alert">{error}</p>
              ) : loading ? (
                <p>读取条件…</p>
              ) : (
                <>
                  <p>
                    {readonly
                      ? '历史版本只读，原证据仍属于原条件版本。'
                      : '编辑会生成新版本；旧证据不会自动满足新条件。'}
                  </p>
                  {items.map((item, index) => (
                    <div className="criterion-row" key={item.id}>
                      <AppInput
                        aria-label={`条件 ${index + 1}`}
                        value={item.description}
                        maxLength={512}
                        disabled={readonly || busy}
                        onChange={(e) =>
                          setItems(
                            items.map((x, i) =>
                              i === index
                                ? { ...x, description: e.target.value }
                                : x,
                            ),
                          )
                        }
                      />
                      {!readonly && (
                        <AppButton
                          aria-label={`删除条件 ${index + 1}`}
                          disabled={busy}
                          onClick={() =>
                            setItems(items.filter((_, i) => i !== index))
                          }
                        >
                          删除
                        </AppButton>
                      )}
                    </div>
                  ))}
                  {!readonly && (
                    <div className="criterion-actions">
                      <AppButton
                        className="secondary"
                        disabled={busy || items.length >= 32}
                        onClick={() =>
                          setItems([
                            ...items,
                            { id: crypto.randomUUID(), description: '' },
                          ])
                        }
                      >
                        添加条件
                      </AppButton>
                      <AppButton
                        className="secondary"
                        disabled={
                          busy || items.some((x) => !x.description.trim())
                        }
                        onClick={() =>
                          void replace(
                            items.map((x) => ({
                              ...x,
                              description: x.description.trim(),
                            })),
                          )
                        }
                      >
                        保存条件
                      </AppButton>
                    </div>
                  )}
                </>
              )}
            </div>
            <AppButton
              className="secondary"
              disabled={busy}
              onClick={() => void update({ archived: !task.archivedAt })}
            >
              {task.archivedAt ? '恢复显示' : '归档事项'}
            </AppButton>
            <p>归档只改变显示范围；手动完成不改变证据核验结果。</p>
          </>
        ) : (
          <p>旧事项尚未分配项目，暂不可编辑。</p>
        )}
      </div>
    </section>
  )
}

import { DeliveryPanel } from './delivery-panel'
import { TaskMerge } from './task-merge'
import { Disclosure } from './ui/disclosure'
import { X, ArrowClockwise, FloppyDisk } from '@phosphor-icons/react'
import { SourceAssociations } from './source-associations'
import { PlanChanges } from './plan-changes'
import { TaskTimeline } from './task-timeline'
import { ReferenceList } from './reference-list'
import './candidate-provenance.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  CoreRequest,
  WorkspaceTask,
  CandidateProvenance,
} from '@memo/contracts'
import { IconButton, AppButton, AppInput } from './ui'
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
export type EditorBaseline = {
  expectedVersion: number
  expectedCriteriaVersion: number
  expectedManualVersion: number
}
const taskBaseline = (task: WorkspaceTask): EditorBaseline => ({
  expectedVersion: task.version,
  expectedCriteriaVersion: task.criteriaVersion,
  expectedManualVersion: task.manualVersion,
})
type EditorDraft = {
  baseline: EditorBaseline
  title: string
  due: string
  version: number
  items: { id: string; description: string; originEventId?: number }[]
}
const editorDrafts = new Map<string, EditorDraft>()
export function TaskEditor({
  task,
  busy: externalBusy,
  update,
  replace,
  split,
  close,
  openRelated,
  onPlanApplied,
  toolbar,
}: {
  task: WorkspaceTask
  busy: boolean
  update: (patch: Patch, baseline?: EditorBaseline) => Promise<void>
  replace: (
    items: { id: string; description: string; originEventId?: number }[],
    baseline?: EditorBaseline,
  ) => Promise<void>
  split: (
    children: { title: string; criterionIds: string[] }[],
  ) => Promise<void>
  onPlanApplied: (task: WorkspaceTask) => void
  openRelated: (id: string) => void
  close: () => void
  toolbar?: ReactNode
}) {
  const [merge, setMerge] = useState<{
    mergedInto: string | null
    mergedFrom: { id: string; title: string }[]
  }>({ mergedInto: null, mergedFrom: [] })
  const busy = externalBusy || !!merge.mergedInto
  const draftKey = JSON.stringify([task.projectId, task.id])
  const restored = useRef(editorDrafts.get(draftKey))
  const [baseline, setBaseline] = useState<EditorBaseline>(
    restored.current?.baseline ?? taskBaseline(task),
  )
  const staleDraft =
    baseline.expectedVersion !== task.version ||
    baseline.expectedCriteriaVersion !== task.criteriaVersion ||
    baseline.expectedManualVersion !== task.manualVersion
  const [title, setTitle] = useState(restored.current?.title ?? task.title),
    [due, setDue] = useState(restored.current?.due ?? localDate(task.dueAt))
  const [version, setVersion] = useState(
      restored.current?.version ?? task.criteriaVersion,
    ),
    [items, setItems] = useState<
      { id: string; description: string; originEventId?: number }[]
    >(restored.current?.items ?? []),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false)
  const [associationRefresh, setAssociationRefresh] = useState(0)
  const [provenance, setProvenance] = useState<CandidateProvenance[]>([])
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [evidenceError, setEvidenceError] = useState('')
  const [splitSelection, setSplitSelection] = useState<Set<string>>(new Set())
  const [splitTitle, setSplitTitle] = useState('')
  const [splitBusy, setSplitBusy] = useState(false)
  const evidenceGeneration = useRef(0)
  const generation = useRef(0)
  const preservePlanDrafts = useRef<number | null>(
    restored.current ? task.version : null,
  )
  const latestDraft = useRef<EditorDraft>({
    title,
    due,
    version,
    items,
    baseline,
  })
  latestDraft.current = { title, due, version, items, baseline }
  useEffect(
    () => () => {
      editorDrafts.delete(draftKey)
      editorDrafts.set(draftKey, structuredClone(latestDraft.current))
      while (editorDrafts.size > 20)
        editorDrafts.delete(editorDrafts.keys().next().value!)
    },
    [draftKey],
  )
  useEffect(() => {
    if (preservePlanDrafts.current === task.version) return
    setBaseline(taskBaseline(task))
    setTitle(task.title)
    setDue(localDate(task.dueAt))
    setVersion(task.criteriaVersion)
  }, [task.id, task.version])
  useEffect(() => {
    const seq = ++generation.current
    evidenceGeneration.current++
    setEvidenceLoading(false)
    setEvidenceError('')
    if (!task.projectId) return
    setLoading(true)
    setProvenance([])
    setError('')
    window.memo.workspace
      .detail(task.projectId, task.id, version)
      .then((r) => {
        if (seq !== generation.current) return
        if (r.ok) {
          if (preservePlanDrafts.current !== task.version)
            setItems(r.data.criteria.items.map((x) => ({ ...x })))
          setProvenance(r.data.provenance ?? [])
          setMerge(r.data.merge ?? { mergedInto: null, mergedFrom: [] })
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
  async function refreshEvidence() {
    if (!task.projectId || evidenceLoading || loading) return
    const seq = ++evidenceGeneration.current
    const current = generation.current
    setEvidenceLoading(true)
    setEvidenceError('')
    try {
      const reply = await window.memo.workspace.detail(
        task.projectId,
        task.id,
        version,
      )
      if (seq !== evidenceGeneration.current || current !== generation.current)
        return
      if (reply.ok) setProvenance(reply.data.provenance ?? [])
      else setEvidenceError('依据读取失败，原有显示保留，请稍后刷新。')
    } catch {
      if (seq === evidenceGeneration.current && current === generation.current)
        setEvidenceError('本地核心暂不可用，原有显示保留。')
    } finally {
      if (seq === evidenceGeneration.current && current === generation.current)
        setEvidenceLoading(false)
    }
  }
  async function resolveDraft(useSaved: boolean) {
    if (busy || loading || !task.projectId) return
    setLoading(true)
    try {
      const r = await window.memo.workspace.detail(
        task.projectId,
        task.id,
        task.criteriaVersion,
      )
      if (
        !r.ok ||
        r.data.task.version !== task.version ||
        r.data.task.manualVersion !== task.manualVersion ||
        r.data.task.criteriaVersion !== task.criteriaVersion
      ) {
        setError('事项再次变更，请关闭详情并重新打开后核对。')
        return
      }
      if (useSaved) {
        setTitle(task.title)
        setDue(localDate(task.dueAt))
        setItems(r.data.criteria.items.map((x) => ({ ...x })))
      }
      setVersion(task.criteriaVersion)
      setBaseline(taskBaseline(task))
      setError('')
    } catch {
      setError('当前内容读取失败，草稿仍保留。')
    } finally {
      setLoading(false)
    }
  }
  const readonly = version !== task.criteriaVersion
  return (
    <section className="detail" aria-label="事项详情">
      <div className="detail-top">
        <span>事项详情</span>
        <div className="detail-top-actions">
          {toolbar}
          <IconButton className="detail-close" label="关闭详情" onClick={close}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div className="real-editor">
        <h2>{task.title}</h2>
        <DeliveryPanel task={task} disabled={busy} onUpdated={onPlanApplied} />
        {merge.mergedInto && (
          <p>
            此事项已合并，历史记录只读。
            <AppButton onClick={() => openRelated(merge.mergedInto!)}>
              打开目标事项
            </AppButton>
          </p>
        )}
        {staleDraft && (
          <section role="alert" aria-label="草稿版本冲突">
            <p>事项已在别处更新，旧草稿已保留。请核对当前保存内容后再提交。</p>
            <p>当前标题：{task.title}</p>
            <p>
              当前截止时间：{task.dueAt ? localDate(task.dueAt) : '未设置'} ·
              当前条件版本：{task.criteriaVersion}
            </p>
            <AppButton
              disabled={busy || loading}
              onClick={() => void resolveDraft(false)}
            >
              已核对，继续使用草稿
            </AppButton>
            <AppButton
              disabled={busy || loading}
              onClick={() => void resolveDraft(true)}
            >
              使用当前保存内容
            </AppButton>
          </section>
        )}

        {task.admission === 'candidate' && (
          <section className="admission-triage" aria-label="收录确认">
            <p>这条事项来自来源整理，确认后才会进入正式跟进。</p>
            <div>
              <AppButton
                disabled={busy}
                onClick={() => void update({ admission: 'accepted' })}
              >
                确认收录
              </AppButton>
              <AppButton
                className="secondary"
                disabled={busy}
                onClick={() => void update({ admission: 'ignored' })}
              >
                忽略
              </AppButton>
            </div>
          </section>
        )}

        <div className="task-state-control">
          {' '}
          <label>
            手动状态
            <select
              aria-label="手动状态"
              disabled={busy || !task.projectId}
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
        </div>
        <div className="evidence-summary">
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
          {task.projectId && (
            <div className="source-import-actions">
              <IconButton
                label="刷新依据"
                disabled={loading || evidenceLoading}
                onClick={() => void refreshEvidence()}
              >
                <ArrowClockwise aria-hidden />
              </IconButton>
              {evidenceLoading && <span>正在读取依据…</span>}
              {evidenceError && <p role="alert">{evidenceError}</p>}
            </div>
          )}
        </div>
        {!loading && provenance.length > 0 && (
          <section className="candidate-provenance" aria-label="候选来源依据">
            <h3>候选来源依据</h3>
            <p>根据原文整理，收录前请核对。引用不代表已完成。</p>
            {provenance.map((item) => (
              <details key={`${item.eventId}:${item.quoteStart}`}>
                <summary>
                  {item.referenceStatus === 'invalidated' && (
                    <strong>
                      {item.eventStatus === 'retracted'
                        ? '原记录已撤回 · 引用已失效 · '
                        : '记录内容已编辑 · 引用待复核 · '}
                    </strong>
                  )}
                  {item.reason === 'source_retracted'
                    ? '查看撤回依据'
                    : item.quoteKind === 'revision_excerpt'
                      ? '查看待复核修订摘录'
                      : '查看原文引用'}{' '}
                  · 修订 {item.revision}
                </summary>
                {item.quote && <blockquote>{item.quote}</blockquote>}
                {item.retraction && (
                  <div>
                    <p>
                      事项保留，不会因消息撤回自动取消或覆盖人工决定，请人工复核。
                    </p>
                    <p>撤回依据：事件 #{item.retraction.eventId}</p>
                    <p>
                      来源标注时间：
                      {new Date(item.retraction.occurredAt).toLocaleString()}
                    </p>
                    <p>
                      收录撤回时间：
                      {new Date(item.retraction.receivedAt).toLocaleString()}
                    </p>
                  </div>
                )}
                {item.quoteKind === 'revision_excerpt' &&
                  item.reason !== 'source_retracted' && (
                    <p>
                      这是后续修订的摘录，尚未应用到事项，也不作为完成证据。
                    </p>
                  )}
                {item.revisionStatus === 'review_required' && (
                  <p>来源有后续修订，请复核此候选；原引用仍保留。</p>
                )}
                {item.sourceStatus !== 'active' && (
                  <p>
                    {
                      (
                        {
                          paused: '来源采集已暂停，原引用仍保留。',
                          revoked: '来源授权已撤销，原引用仍保留。',
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
            <Disclosure title="编辑事项与完成条件">
              <div className="editor-group">
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (!staleDraft)
                      void update({ title: title.trim() }, baseline)
                  }}
                >
                  <AppInput
                    aria-label="编辑事项标题"
                    value={title}
                    maxLength={512}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <IconButton
                    label="保存标题"
                    type="submit"
                    className="secondary"
                    disabled={busy || staleDraft || !title.trim()}
                  >
                    <FloppyDisk aria-hidden />
                  </IconButton>
                </form>

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
                    if (!staleDraft)
                      void update(
                        { dueAt: date?.toISOString() ?? null },
                        baseline,
                      )
                  }}
                >
                  <label htmlFor="task-due">截止时间（本机时区）</label>
                  <AppInput
                    id="task-due"
                    type="datetime-local"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                  />
                  <IconButton
                    label="保存截止时间"
                    type="submit"
                    className="secondary"
                    disabled={busy || staleDraft}
                  >
                    <FloppyDisk aria-hidden />
                  </IconButton>
                  <AppButton
                    className="secondary"
                    disabled={busy || staleDraft}
                    onClick={() => {
                      if (staleDraft) return
                      setDue('')
                      if (!staleDraft) void update({ dueAt: null }, baseline)
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
              </div>
              <div className="criteria-editor">
                <label>
                  完成条件
                  <select
                    aria-label="条件版本"
                    value={version}
                    disabled={loading}
                    onChange={(e) => setVersion(Number(e.target.value))}
                  >
                    {Array.from(
                      { length: task.criteriaVersion + 1 },
                      (_, i) => (
                        <option key={i} value={i}>
                          版本 {i}
                          {i === task.criteriaVersion ? '（当前）' : '（历史）'}
                        </option>
                      ),
                    )}
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
                            busy ||
                            staleDraft ||
                            items.some((x) => !x.description.trim())
                          }
                          onClick={() =>
                            !staleDraft &&
                            void replace(
                              items.map((x) => ({
                                ...x,
                                description: x.description.trim(),
                              })),
                              baseline,
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
              <div className="editor-group editor-secondary">
                <AppButton
                  className="secondary"
                  disabled={busy}
                  onClick={() => void update({ archived: !task.archivedAt })}
                >
                  {task.archivedAt ? '恢复显示' : '归档事项'}
                </AppButton>
                <p>归档只改变显示范围；手动完成不改变证据核验结果。</p>
              </div>
            </Disclosure>
          </>
        ) : (
          <p>旧事项尚未分配项目，暂不可编辑。</p>
        )}
        {merge.mergedFrom.length > 0 && (
          <Disclosure title="合并来源与原始历史" id="merge-history">
            {merge.mergedFrom.map((t) => (
              <AppButton key={t.id} onClick={() => openRelated(t.id)}>
                {t.title}
              </AppButton>
            ))}
          </Disclosure>
        )}
        {!merge.mergedInto && !task.archivedAt && (
          <TaskMerge
            task={task}
            disabled={busy}
            onMerged={(next) => openRelated(next.id)}
          />
        )}
        {task.projectId && !merge.mergedInto && !task.archivedAt && (
          <Disclosure title="拆分事项" description="把部分条件拆成独立事项">
            <div className="task-structure">
              {readonly ? (
                <p>仅当前条件版本可拆分，请先切回最新版本。</p>
              ) : items.length < 2 ? (
                <p>至少需要两个条件才能拆分。</p>
              ) : (
                <>
                  <p>
                    勾选要移出的完成条件，拆分为一条新事项；相关证据随条件移动，本事项保留其余条件。
                  </p>
                  <ul className="split-criteria">
                    {items.map((item) => (
                      <li key={item.id}>
                        <label>
                          <input
                            type="checkbox"
                            checked={splitSelection.has(item.id)}
                            disabled={
                              splitBusy || busy || !item.description.trim()
                            }
                            onChange={(e) => {
                              const next = new Set(splitSelection)
                              if (e.target.checked) next.add(item.id)
                              else next.delete(item.id)
                              setSplitSelection(next)
                            }}
                          />
                          {item.description || '（未填写描述的条件）'}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (
                        splitBusy ||
                        busy ||
                        staleDraft ||
                        !splitTitle.trim() ||
                        !splitSelection.size ||
                        splitSelection.size >= items.length
                      )
                        return
                      setSplitBusy(true)
                      void split([
                        {
                          title: splitTitle.trim(),
                          criterionIds: [...splitSelection],
                        },
                      ])
                        .catch(() => undefined)
                        .finally(() => setSplitBusy(false))
                      setSplitSelection(new Set())
                      setSplitTitle('')
                    }}
                  >
                    <AppInput
                      aria-label="新事项标题"
                      placeholder="拆分出的新事项标题"
                      value={splitTitle}
                      maxLength={512}
                      disabled={splitBusy || busy}
                      onChange={(e) => setSplitTitle(e.target.value)}
                    />
                    <AppButton
                      type="submit"
                      className="secondary"
                      disabled={
                        splitBusy ||
                        busy ||
                        staleDraft ||
                        !splitTitle.trim() ||
                        !splitSelection.size ||
                        splitSelection.size >= items.length
                      }
                    >
                      拆分出所选条件
                    </AppButton>
                  </form>
                  <p>新事项继承收录状态与负责人，截止时间需单独设置。</p>
                </>
              )}
            </div>
          </Disclosure>
        )}
        <Disclosure title="关联、改期与历史">
          {task.projectId && (
            <SourceAssociations
              task={task}
              busy={busy}
              onChanged={() => setAssociationRefresh((value) => value + 1)}
            />
          )}
          {task.projectId && (
            <PlanChanges
              refreshVersion={associationRefresh}
              task={task}
              busy={busy}
              onApplied={(next) => {
                setDue((old) =>
                  old === localDate(task.dueAt) ? localDate(next.dueAt) : old,
                )
                preservePlanDrafts.current = next.version
                onPlanApplied(next)
              }}
            />
          )}
          {task.projectId && (
            <ReferenceList
              projectId={task.projectId}
              taskId={task.id}
              onConfirmed={() => void refreshEvidence()}
            />
          )}
          {task.projectId && (
            <TaskTimeline
              key={`${task.projectId}:${task.id}`}
              projectId={task.projectId}
              taskId={task.id}
            />
          )}
        </Disclosure>
      </div>
    </section>
  )
}

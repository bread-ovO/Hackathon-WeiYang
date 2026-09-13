import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CoreReply,
  CoreRequest,
  WorkspaceSnapshot,
  WorkspaceQuery,
  WorkspaceTask,
} from '@memo/contracts'
import {
  Plus,
  SlidersHorizontal,
  ArrowClockwise,
  X,
  MagnifyingGlass,
} from '@phosphor-icons/react'
import { TooltipProvider } from '@cloudflare/kumo/components/tooltip'
import './workspace-simple.css'
import {
  IconButton,
  AppDialog,
  DialogTitle,
  DialogDescription,
  AppButton,
  AppInput,
} from './ui'
import { Badge } from '@cloudflare/kumo/components/badge'
import { TaskEditor, taskLabels, type EditorBaseline } from './task-editor'
import { TaskExport } from './task-export'

const realStatusVariants = {
  todo: 'warning',
  in_progress: 'info',
  waiting: 'secondary',
  completed: 'success',
  cancelled: 'secondary',
} as const

export function RealWorkspace({
  onCount,
  openTask,
  onConnect,
}: {
  onCount: (count: number) => void
  openTask?: { projectId: string; taskId: string; nonce: number } | null
  onConnect?: () => void
}) {
  const [data, setData] = useState<WorkspaceSnapshot>({
    projects: [],
    tasks: [],
    nextCursor: null,
    totalCount: 0,
    activeCount: 0,
  })
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState('')
  const [project, setProject] = useState(''),
    [title, setTitle] = useState(''),
    [name, setName] = useState('')
  const [query, setQuery] = useState(''),
    [archive, setArchive] = useState(false),
    [status, setStatus] = useState(''),
    [admission, setAdmission] = useState('')
  const [source, setSource] = useState(''),
    [activity, setActivity] = useState('')
  const [activityNow] = useState(() => Date.now())
  const [sourceOptions, setSourceOptions] = useState<
    { id: string; name: string; projectId: string }[]
  >([])
  useEffect(() => {
    let active = true
    void Promise.all([
      window.memo.sources.list(),
      window.memo.github.list(),
      window.memo.feishu.list(),
      window.memo.plugins.list(),
    ])
      .then(([local, github, feishu, plugins]) => {
        if (!active) return
        setSourceOptions([
          ...(local.ok
            ? local.data.sources.map((s) => ({
                id: s.id,
                name: s.displayName,
                projectId: s.projectId,
              }))
            : []),
          ...(github.ok
            ? github.data.connections.map((s) => ({
                id: s.id,
                name:
                  s.mode === 'account'
                    ? `GitHub · ${s.owner}（账户）`
                    : `GitHub · ${s.owner}/${s.repo}`,
                projectId: s.projectId,
              }))
            : []),
          ...(feishu.ok
            ? feishu.data.connections.map((s) => ({
                id: s.id,
                name: `飞书 · ${s.chatId}`,
                projectId: s.projectId,
              }))
            : []),
          ...(plugins.ok
            ? plugins.data.plugins.map((s) => ({
                id: s.sourceInstanceId ?? s.id,
                name: s.displayName,
                projectId: s.projectId,
              }))
            : []),
        ])
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  const [createOpen, setCreateOpen] = useState(false),
    [filtersOpen, setFiltersOpen] = useState(false),
    [createProject, setCreateProject] = useState('')
  const filterButton = useRef<HTMLButtonElement>(null)
  const filterCount = [project, status, admission, source, activity].filter(
    Boolean,
  ).length
  function clearFilters() {
    setProject('')
    setStatus('')
    setAdmission('')
    setSource('')
    setActivity('')
    setQuery('')
  }
  const [selected, setSelected] = useState<string | null>(null)
  const seq = useRef(0),
    mutating = useRef(false)
  const [newResults, setNewResults] = useState(false)
  const processed = useRef<number | null>(null)
  useEffect(() => {
    let active = true,
      checking = false
    const check = async () => {
      if (checking || document.hidden) return
      checking = true
      try {
        const reply = await window.memo.processing.status()
        if (!active || !reply.ok) return
        if (
          processed.current !== null &&
          reply.data.processedCount !== processed.current
        )
          setNewResults(true)
        processed.current = reply.data.processedCount
      } catch {
        /* list remains usable while the local core reconnects */
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])
  const current = data.tasks.find((t) => t.id === selected)
  const filters = JSON.stringify({
    ...(project ? { projectId: project } : {}),
    ...(status ? { status } : {}),
    ...(admission ? { admission } : {}),
    archive: archive ? 'archived' : 'active',
    query,
    limit: 50,
    ...(source ? { sourceInstanceId: source } : {}),
    ...(activity === 'recent'
      ? { updatedSince: new Date(activityNow - 7 * 86400000).toISOString() }
      : activity === 'quiet'
        ? { updatedBefore: new Date(activityNow - 30 * 86400000).toISOString() }
        : {}),
  })
  const load = useCallback(
    async (append = false, cursor?: string) => {
      const generation = ++seq.current
      setBusy(true)
      try {
        const r = await window.memo.workspace.list({
          ...(JSON.parse(filters) as WorkspaceQuery),
          ...(cursor ? { cursor } : {}),
        })
        if (generation !== seq.current) return
        if (r.ok) {
          setData((old) => ({
            ...r.data,
            tasks: append
              ? [
                  ...old.tasks,
                  ...r.data.tasks.filter(
                    (t) => !old.tasks.some((o) => o.id === t.id),
                  ),
                ]
              : r.data.tasks,
          }))
          onCount(r.data.activeCount)
        } else setMessage('读取失败，请刷新后重试。')
      } catch {
        if (generation === seq.current)
          setMessage('本地核心暂不可用，请稍后刷新。')
      } finally {
        if (generation === seq.current) setBusy(false)
      }
    },
    [filters, onCount],
  )
  const latestLoad = useRef(load)
  latestLoad.current = load
  useEffect(() => {
    setSelected(null)
    void load()
    return () => {
      seq.current++
    }
  }, [load])
  const openedPetNonce = useRef<number | null>(null)
  useEffect(() => {
    if (!openTask || busy || openedPetNonce.current === openTask.nonce) return
    let active = true
    // Wait for the normal list refresh; the target may be outside this page/filter.
    void window.memo.workspace
      .detail(openTask.projectId, openTask.taskId)
      .then((reply) => {
        if (!active) return
        if (!reply.ok) {
          setMessage('此事项当前不可打开，请刷新工作区。')
          return
        }
        openedPetNonce.current = openTask.nonce
        setData((old) => ({
          ...old,
          tasks: [
            reply.data.task,
            ...old.tasks.filter((t) => t.id !== reply.data.task.id),
          ],
        }))
        setSelected(reply.data.task.id)
      })
      .catch(() => {
        if (active) setMessage('事项暂不可打开，请稍后重试。')
      })
    return () => {
      active = false
    }
  }, [openTask?.nonce, busy])
  async function run(
    action: () => Promise<CoreReply<unknown>>,
    success: string,
    after?: (reply: Extract<CoreReply<unknown>, { ok: true }>) => void,
  ) {
    if (mutating.current) return
    mutating.current = true
    setSaving(true)
    setBusy(true)
    seq.current++
    try {
      const r = await action()
      if (r.ok) {
        setMessage(success)
        after?.(r)
        await latestLoad.current()
      } else
        setMessage(
          r.error === 'VERSION_CONFLICT'
            ? '事项已被更新，请刷新后重试。你的修改尚未保存。'
            : '操作未成功，请检查输入后重试。',
        )
    } catch {
      setMessage('本地核心暂不可用，请稍后刷新。')
    } finally {
      mutating.current = false
      setSaving(false)
      setBusy(false)
    }
  }
  function expectation(t: WorkspaceTask) {
    return {
      projectId: t.projectId!,
      id: t.id,
      expectedVersion: t.version,
      expectedCriteriaVersion: t.criteriaVersion,
      expectedManualVersion: t.manualVersion,
    }
  }
  async function update(
    patch: Extract<CoreRequest, { method: 'workspace.updateTask' }>['patch'],
    baseline?: EditorBaseline,
  ) {
    if (current?.projectId)
      await run(
        () =>
          window.memo.workspace.updateTask({
            ...expectation(current),
            ...baseline,
            patch,
          }),
        '已保存到本地，人工操作已记录。',
      )
  }
  async function replace(
    criteria: { id: string; description: string; originEventId?: number }[],
    baseline?: EditorBaseline,
  ) {
    if (current?.projectId)
      await run(
        () =>
          window.memo.workspace.replaceCriteria({
            ...expectation(current),
            ...baseline,
            criteria,
          }),
        '条件新版本已保存，旧证据仍保留在原版本。',
      )
  }
  async function split(children: { title: string; criterionIds: string[] }[]) {
    if (!current?.projectId) return
    await run(
      () =>
        window.memo.workspace.splitTask({
          projectId: current.projectId!,
          taskId: current.id,
          expectedVersion: current.version,
          expectedCriteriaVersion: current.criteriaVersion,
          expectedManualVersion: current.manualVersion,
          children,
        }),
      '已拆分：所选条件与证据移入新事项。',
    )
  }
  return (
    <TooltipProvider delay={300}>
      <div className="page-heading compact-heading">
        <div>
          <h1>
            跟进<span className="heading-dot">.</span>
          </h1>
          <p>选择一件事，查看进展与下一步。</p>
        </div>
        <div className="workspace-actions">
          <TaskExport
            projects={data.projects}
            selected={current}
            disabled={saving || busy}
          />
          <IconButton
            label="刷新"
            disabled={saving || busy}
            onClick={() => void load()}
          >
            <ArrowClockwise aria-hidden />
          </IconButton>
          <IconButton
            ref={filterButton}
            label="筛选事项"
            aria-expanded={filtersOpen}
            aria-controls="workspace-filter-panel"
            aria-pressed={filterCount > 0}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <SlidersHorizontal aria-hidden />
          </IconButton>
          {filterCount > 0 && (
            <span
              className="filter-count"
              aria-label={`${filterCount} 项筛选已启用`}
            >
              {filterCount}
            </span>
          )}
          <IconButton
            label="新建事项"
            variant="primary"
            className="create-action"
            onClick={() => {
              setCreateProject(project || data.projects[0]?.id || '')
              setMessage('')
              setCreateOpen(true)
            }}
          >
            <Plus aria-hidden />
          </IconButton>
        </div>
      </div>
      <AppDialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!saving) setCreateOpen(open)
        }}
      >
        <div className="create-dialog-content">
          <DialogTitle>新建事项</DialogTitle>
          <DialogDescription>
            记下需要跟进的事，放进一个项目。
          </DialogDescription>
          {message && <p role="status">{message}</p>}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (createProject && title.trim())
                void run(
                  () =>
                    window.memo.workspace.createTask(
                      createProject,
                      title.trim(),
                    ),
                  '事项已保存。',
                  () => {
                    setTitle('')
                    setCreateOpen(false)
                  },
                )
            }}
          >
            <select
              disabled={saving}
              aria-label="所属项目"
              value={createProject}
              onChange={(e) => {
                setCreateProject(e.target.value)
              }}
            >
              <option value="">选择项目</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <AppInput
              autoFocus
              aria-label="真实事项标题"
              placeholder="需要跟进什么？"
              maxLength={512}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <AppButton
              type="submit"
              className="primary"
              disabled={saving || busy || !createProject || !title.trim()}
            >
              添加事项
            </AppButton>
          </form>
          <details
            className="create-project-disclosure"
            open={data.projects.length === 0 ? true : undefined}
          >
            <summary>新建项目</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (name.trim())
                  void run(
                    () => window.memo.workspace.createProject(name.trim()),
                    '项目已创建。',
                    (r) => {
                      setName('')
                      const created = (
                        r.data as { projects?: { id: string }[] } | undefined
                      )?.projects?.[0]
                      if (created) setCreateProject(created.id)
                    },
                  )
              }}
            >
              <AppInput
                aria-label="新项目名称"
                placeholder="新项目名称"
                maxLength={128}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <AppButton
                type="submit"
                className="secondary"
                disabled={saving || busy || !name.trim()}
              >
                创建项目
              </AppButton>
            </form>
          </details>
        </div>
        <IconButton
          label="关闭新建事项"
          className="create-dialog-close"
          disabled={saving}
          onClick={() => setCreateOpen(false)}
        >
          <X aria-hidden />
        </IconButton>
      </AppDialog>
      <div className="workspace-toolbar">
        <div className="workspace-tabs">
          <AppButton
            aria-label="未归档"
            aria-pressed={!archive}
            disabled={saving}
            onClick={() => setArchive(false)}
          >
            跟进清单
          </AppButton>
          <AppButton
            aria-pressed={archive}
            disabled={saving}
            onClick={() => setArchive(true)}
          >
            已归档
          </AppButton>
        </div>
        <div className="workspace-search">
          <MagnifyingGlass aria-hidden />
          <AppInput
            disabled={saving}
            aria-label="搜索本地事项"
            placeholder="搜索事项与条件"
            maxLength={256}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {filterCount > 0 && !filtersOpen && (
        <div className="active-filter-summary">
          <span>
            {[
              data.projects.find((p) => p.id === project)?.name,
              status ? taskLabels[status as keyof typeof taskLabels] : null,
              admission
                ? {
                    accepted: '已收录',
                    candidate: '待确认',
                    ignored: '已忽略',
                  }[admission]
                : null,
              source ? sourceOptions.find((s) => s.id === source)?.name : null,
              activity === 'recent'
                ? '最近 7 天更新'
                : activity === 'quiet'
                  ? '30 天无更新'
                  : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <IconButton label="清除筛选" disabled={saving} onClick={clearFilters}>
            <X aria-hidden />
          </IconButton>
        </div>
      )}
      {filtersOpen && (
        <section
          id="workspace-filter-panel"
          className="workspace-filter-panel"
          aria-label="事项筛选"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setFiltersOpen(false)
              filterButton.current?.focus()
            }
          }}
        >
          <select
            aria-label="项目筛选"
            value={project}
            disabled={saving}
            onChange={(e) => {
              setProject(e.target.value)
              setSource('')
            }}
          >
            <option value="">全部项目</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>{' '}
          <select
            disabled={saving}
            aria-label="业务状态筛选"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">全部状态</option>
            {Object.entries(taskLabels).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select
            disabled={saving}
            aria-label="收录筛选"
            value={admission}
            onChange={(e) => setAdmission(e.target.value)}
          >
            <option value="">全部收录</option>
            <option value="accepted">已收录</option>
            <option value="candidate">待确认</option>
            <option value="ignored">已忽略</option>
          </select>
          <select
            aria-label="来源筛选"
            value={source}
            disabled={saving}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">全部来源</option>
            {sourceOptions
              .filter((s) => !project || s.projectId === project)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <select
            aria-label="活跃度筛选"
            value={activity}
            disabled={saving}
            onChange={(e) => setActivity(e.target.value)}
          >
            <option value="">全部活跃度</option>
            <option value="recent">最近7天有更新</option>
            <option value="quiet">30天无更新</option>
          </select>
          <AppButton disabled={saving || !filterCount} onClick={clearFilters}>
            重置
          </AppButton>
          <IconButton
            label="收起筛选"
            onClick={() => {
              setFiltersOpen(false)
              filterButton.current?.focus()
            }}
          >
            <X aria-hidden />
          </IconButton>
        </section>
      )}
      {message && !createOpen && (
        <p role="status" className="real-message">
          {message}
        </p>
      )}
      {newResults && (
        <div className="source-import-actions" role="status">
          <span>有新的整理结果，刷新列表后查看。请先保存正在编辑的内容。</span>
          <AppButton
            disabled={saving || busy}
            onClick={() => {
              setNewResults(false)
              void load()
            }}
          >
            刷新整理结果
          </AppButton>
        </div>
      )}
      <div className="work-body">
        <section className="task-list" aria-label="事项列表">
          <div className="list-caption">
            <span>
              已显示 {data.tasks.length} / {data.totalCount}
            </span>
            {busy && <span>读取中…</span>}
          </div>
          {data.tasks.length ? (
            data.tasks.map((t) => (
              <AppButton
                key={t.id}
                className={`task-row ${selected === t.id ? 'chosen' : ''}`}
                onClick={() => setSelected(t.id)}
              >
                <span className="task-copy">
                  <span className="task-title">{t.title}</span>
                  <span className="task-meta">
                    {data.projects.find((p) => p.id === t.projectId)?.name ??
                      '旧事项 · 未分配项目'}{' '}
                    ·{' '}
                    {t.admission === 'candidate' ? (
                      <Badge variant="warning">待确认收录</Badge>
                    ) : t.admission === 'ignored' ? (
                      '已忽略'
                    ) : (
                      '已收录'
                    )}
                  </span>
                </span>
                <span className="task-trailing">
                  <Badge
                    variant={realStatusVariants[t.status] ?? 'secondary'}
                    className="task-status"
                  >
                    {taskLabels[t.status]}
                  </Badge>
                  <small>
                    {t.dueAt ? new Date(t.dueAt).toLocaleString() : '未设截止'}
                  </small>
                </span>
              </AppButton>
            ))
          ) : (
            <div className="empty-state">
              <h2>
                {project ||
                query ||
                status ||
                admission ||
                archive ||
                source ||
                activity
                  ? '没有匹配的事项'
                  : '你的跟进清单，从这里开始'}
              </h2>
              <p>
                {project ||
                query ||
                status ||
                admission ||
                archive ||
                source ||
                activity
                  ? '可以调整筛选条件再试。'
                  : '记下第一件事，或连接来源，让承诺自动进入这里。'}
              </p>
              {project ||
              query ||
              status ||
              admission ||
              archive ||
              source ||
              activity ? (
                <AppButton
                  className="secondary"
                  onClick={() => {
                    setProject('')
                    setQuery('')
                    setStatus('')
                    setAdmission('')
                    setArchive(false)
                    setSource('')
                    setActivity('')
                  }}
                >
                  清除筛选
                </AppButton>
              ) : (
                <div className="empty-actions">
                  <AppButton
                    variant="primary"
                    onClick={() => {
                      setCreateProject(data.projects[0]?.id || '')
                      setMessage('')
                      setCreateOpen(true)
                    }}
                  >
                    新建第一件事
                  </AppButton>
                  {onConnect && (
                    <AppButton className="secondary" onClick={onConnect}>
                      去连接来源
                    </AppButton>
                  )}
                </div>
              )}
            </div>
          )}
          {data.nextCursor && (
            <AppButton
              className="secondary load-more"
              disabled={saving || busy}
              onClick={() => void load(true, data.nextCursor!)}
            >
              加载更多
            </AppButton>
          )}
        </section>
      </div>
      <AppDialog
        open={!!current}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        className="detail-dialog"
      >
        {current && (
          <TaskEditor
            openRelated={async (id) => {
              if (!current.projectId) return
              const r = await window.memo.workspace.detail(
                current.projectId,
                id,
              )
              if (r.ok) {
                await latestLoad.current()
                setData((old) => ({
                  ...old,
                  tasks: [r.data.task, ...old.tasks.filter((t) => t.id !== id)],
                }))
                setSelected(id)
              }
            }}
            key={current.id}
            task={current}
            toolbar={
              current.projectId ? (
                <TaskExport
                  projects={data.projects}
                  selected={current}
                  disabled={saving || busy}
                />
              ) : undefined
            }
            onPlanApplied={(next) =>
              setData((old) => ({
                ...old,
                tasks: old.tasks.map((item) =>
                  item.id === next.id ? next : item,
                ),
              }))
            }
            busy={busy || saving}
            update={update}
            replace={replace}
            split={split}
            close={() => setSelected(null)}
          />
        )}
        {current && message && (
          <p role="status" className="detail-dialog-message">
            {message}
          </p>
        )}
      </AppDialog>
    </TooltipProvider>
  )
}

import { useEffect, useState } from 'react'
import type {
  CoreReply,
  WorkspaceSnapshot,
  WorkspaceTask,
} from '@memo/contracts'
import { AppButton, AppInput } from './ui'
const statuses = {
  todo: '待办',
  in_progress: '进行中',
  waiting: '等待反馈',
  completed: '已完成',
  cancelled: '已取消',
} as const
export function RealWorkspace({
  onCount,
}: {
  onCount: (count: number) => void
}) {
  const [data, setData] = useState<WorkspaceSnapshot>({
    projects: [],
    tasks: [],
  })
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('正在读取本地事项…')
  const [project, setProject] = useState(''),
    [title, setTitle] = useState(''),
    [name, setName] = useState('')
  const [query, setQuery] = useState(''),
    [archive, setArchive] = useState(false)
  const [selected, setSelected] = useState<string | null>(null),
    [edit, setEdit] = useState('')
  const current = data.tasks.find((t) => t.id === selected)
  async function run(
    action: () => Promise<CoreReply<WorkspaceSnapshot>>,
    success = '',
  ) {
    setBusy(true)
    try {
      const reply = await action()
      if (reply.ok) {
        setData(reply.data)
        onCount(
          reply.data.tasks.filter(
            (t) =>
              !t.archivedAt &&
              t.status !== 'completed' &&
              t.status !== 'cancelled',
          ).length,
        )
        setMessage(success)
      } else
        setMessage(
          reply.error === 'VERSION_CONFLICT'
            ? '事项已被更新，请刷新后重试。你的修改尚未保存。'
            : '操作未成功，请重试。',
        )
    } catch {
      setMessage('本地核心暂不可用，请稍后刷新。')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void run(() => window.memo.workspace.list())
  }, [])
  function update(
    task: WorkspaceTask,
    patch: {
      title?: string
      status?: WorkspaceTask['status']
      archived?: boolean
    },
  ) {
    if (!task.projectId) return
    return run(
      () =>
        window.memo.workspace.updateTask({
          projectId: task.projectId!,
          id: task.id,
          expectedVersion: task.version,
          expectedCriteriaVersion: task.criteriaVersion,
          expectedManualVersion: task.manualVersion,
          patch,
        }),
      '已保存到本地，人工操作已记录。',
    )
  }
  const visible = data.tasks.filter(
    (t) =>
      (!project || t.projectId === project) &&
      Boolean(t.archivedAt) === archive &&
      t.title.includes(query),
  )
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>
            跟进<span className="heading-dot">.</span>
          </h1>
          <p>本地事项 · 人工状态与证据充分度分开记录</p>
        </div>
        <AppButton
          className="secondary"
          disabled={busy}
          onClick={() => void run(() => window.memo.workspace.list())}
        >
          刷新
        </AppButton>
      </div>
      <div className="real-create">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim())
              void run(
                () => window.memo.workspace.createProject(name.trim()),
                '项目已创建。',
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
            disabled={busy || !name.trim()}
          >
            创建项目
          </AppButton>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (project && title.trim())
              void run(
                () => window.memo.workspace.createTask(project, title.trim()),
                '事项已保存。',
              )
          }}
        >
          <select
            aria-label="所属项目"
            value={project}
            onChange={(e) => setProject(e.target.value)}
          >
            <option value="">全部项目 / 请选择</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <AppInput
            aria-label="真实事项标题"
            placeholder="需要跟进什么？"
            maxLength={512}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <AppButton
            type="submit"
            className="primary"
            disabled={busy || !project || !title.trim()}
          >
            添加事项
          </AppButton>
        </form>
      </div>
      <div className="list-tools">
        <div className="filters">
          <AppButton aria-pressed={!archive} onClick={() => setArchive(false)}>
            跟进中
          </AppButton>
          <AppButton aria-pressed={archive} onClick={() => setArchive(true)}>
            已归档
          </AppButton>
        </div>
        <AppInput
          aria-label="搜索本地事项"
          placeholder="搜索事项"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {message && (
        <p role="status" className="real-message">
          {message}
        </p>
      )}
      <div className={`work-body ${current ? 'has-detail' : ''}`}>
        <section className="task-list" aria-label="事项列表">
          {visible.length ? (
            visible.map((t) => (
              <AppButton
                key={t.id}
                className={`task-row ${selected === t.id ? 'chosen' : ''}`}
                onClick={() => {
                  setSelected(t.id)
                  setEdit(t.title)
                }}
              >
                <span className="task-copy">
                  <span className="task-title">{t.title}</span>
                  <span className="task-meta">
                    {data.projects.find((p) => p.id === t.projectId)?.name ??
                      '旧事项 · 未分配项目'}{' '}
                    ·{' '}
                    {t.admission === 'candidate'
                      ? '待确认收录'
                      : t.admission === 'ignored'
                        ? '已忽略'
                        : '已收录'}
                  </span>
                </span>
                <span className="task-trailing">{statuses[t.status]}</span>
              </AppButton>
            ))
          ) : (
            <div className="empty-state">
              <h2>
                {data.tasks.length
                  ? '没有匹配的事项'
                  : '你的跟进清单，从这里开始'}
              </h2>
              <p>先创建项目，再添加真实事项。来源自动采集尚未接入。</p>
            </div>
          )}
          <div className="list-foot">
            每项目最多显示 100 条 · 手动添加不会伪造来源或完成证据
          </div>
        </section>
        {current && (
          <section className="detail" aria-label="事项详情">
            <div className="detail-top">
              <AppButton onClick={() => setSelected(null)}>关闭详情</AppButton>
            </div>
            <div className="real-editor">
              <h2>{current.title}</h2>
              <p>业务状态：{statuses[current.status]}</p>
              <p>
                证据：
                {
                  {
                    unknown: '尚未核验',
                    partial: '部分充分',
                    sufficient: '充分',
                    conflict: '存在冲突',
                  }[current.evidenceStatus]
                }
              </p>
              {current.projectId ? (
                <>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (edit.trim())
                        void update(current, { title: edit.trim() })
                    }}
                  >
                    <AppInput
                      aria-label="编辑事项标题"
                      value={edit}
                      maxLength={512}
                      onChange={(e) => setEdit(e.target.value)}
                    />
                    <AppButton
                      type="submit"
                      className="secondary"
                      disabled={busy || !edit.trim()}
                    >
                      保存标题
                    </AppButton>
                  </form>
                  <label>
                    手动状态
                    <select
                      aria-label="手动状态"
                      disabled={busy}
                      value={current.status}
                      onChange={(e) =>
                        void update(current, {
                          status: e.target.value as WorkspaceTask['status'],
                        })
                      }
                    >
                      {Object.entries(statuses).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <AppButton
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void update(current, { archived: !current.archivedAt })
                    }
                  >
                    {current.archivedAt ? '恢复显示' : '归档事项'}
                  </AppButton>
                  <p>归档只改变显示范围；手动完成不改变证据核验结果。</p>
                </>
              ) : (
                <p>旧事项尚未分配项目，暂不可编辑。</p>
              )}
            </div>
          </section>
        )}
      </div>
    </>
  )
}

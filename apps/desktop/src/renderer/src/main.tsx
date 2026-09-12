import { PluginManager } from './plugin-manager'
import { CredentialsPanel } from './credentials-panel'
import { SourceImport } from './source-import'
import { RealWorkspace } from './real-workspace'
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  List,
  Link,
  MagnifyingGlass,
  SlidersHorizontal,
  Plus,
  ArrowRight,
  Check,
  Clock,
  X,
  CaretLeft,
  FileText,
  ChatsCircle,
  TerminalWindow,
  GithubLogo,
  FolderSimple,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import type { DesktopBridge, Health, PetModelIssue, PetSpeechState, PetState } from '@memo/contracts'
import { demoTasks, type Task } from './demo'
import {
  AppButton,
  AppInput,
  AppDialog,
  DialogTitle,
  DialogDescription,
  StatusBadge,
  WorkspacePanel,
} from './ui'
import '@cloudflare/kumo/styles/standalone'
import './style.css'
declare global {
  interface Window {
    memo: DesktopBridge
  }
}
type IconName =
  | 'list'
  | 'link'
  | 'search'
  | 'settings'
  | 'plus'
  | 'arrow'
  | 'check'
  | 'clock'
  | 'close'
  | 'back'
  | 'file'
  | 'chat'
  | 'terminal'
  | 'github'
  | 'folder'
const icons: Record<IconName, PhosphorIcon> = {
  list: List,
  link: Link,
  search: MagnifyingGlass,
  settings: SlidersHorizontal,
  plus: Plus,
  arrow: ArrowRight,
  check: Check,
  clock: Clock,
  close: X,
  back: CaretLeft,
  file: FileText,
  chat: ChatsCircle,
  terminal: TerminalWindow,
  github: GithubLogo,
  folder: FolderSimple,
}
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Component = icons[name]
  return <Component size={size} weight="regular" aria-hidden="true" />
}
const filters = ['全部', '进行中', '等待反馈', '待确认', '已完成'] as const
function App() {
  const [health, setHealth] = useState<Health | null>(null),
    [error, setError] = useState(false)
  const [page, setPage] = useState('跟进'),
    [demo, setDemo] = useState(true),
    [tasks, setTasks] = useState(demoTasks)
  const [filter, setFilter] = useState<string>('全部'),
    [project, setProject] = useState('全部项目'),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState<string | null>('01')
  const [detailTab, setDetailTab] = useState('概览'),
    [evidence, setEvidence] = useState<number | null>(null),
    [modal, setModal] = useState(false),
    [draft, setDraft] = useState(''),
    [notice, setNotice] = useState('')
  const [undo, setUndo] = useState<Task[] | null>(null)
  const [realCount, setRealCount] = useState(0)
  const searchRef = useRef<HTMLInputElement>(null)
  const [petState, setPetState] = useState<PetState | null>(null),
    [petBusy, setPetBusy] = useState(false),
    [petMessage, setPetMessage] = useState(''),
    [petIssues, setPetIssues] = useState<PetModelIssue[] | null>(null),
    [speech, setSpeech] = useState<PetSpeechState | null>(null)
    const refreshPet = async () => {
    // The pet worker starts alongside the app; tolerate a brief not-ready window.
    const r = await window.memo.pet.speechConfig()
    if (r.ok) setSpeech(r.data)
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await window.memo.pet.state()
      if (reply.ok) {
        setPetState(reply.data)
        return
      }
      if (reply.error !== 'PET_UNAVAILABLE') return
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  const finishImport = async (entry: string) => {
    setPetBusy(true)
    try {
      const reply = await window.memo.pet.importChosen(entry)
      if (!reply.ok) {
        setPetMessage('导入没有完成，请重新选择目录。')
        return
      }
      const result = reply.data
      if (result.status === 'invalid') {
        setPetIssues(result.issues)
        setPetMessage('模型未通过校验，没有导入。')
        return
      }
      setPetMessage(
        result.status === 'duplicate'
          ? '这个模型已经导入过，未重复复制。'
          : '模型已导入，可在列表中设为当前。',
      )
      await refreshPet()
    } finally {
      setPetBusy(false)
    }
  }
  const startPetImport = async () => {
    setPetIssues(null)
    setPetMessage('')
    setPetBusy(true)
    try {
      const reply = await window.memo.pet.openImportDialog()
      if (!reply.ok) {
        setPetMessage('暂时无法打开目录选择。')
        return
      }
      const choice = reply.data
      if (choice.status === 'cancelled') return
      if (choice.status === 'no-model') {
        setPetMessage(
          choice.cmo3Found
            ? '目录里没有 .model3.json；.cmo3 是编辑工程文件，请先在 Cubism Editor 导出运行时模型。'
            : '目录里没有找到 .model3.json 模型入口。',
        )
        return
      }
      if (choice.status === 'ready') {
        await finishImport(choice.entry)
        return
      }
      void choice.entries
    } finally {
      setPetBusy(false)
    }
  }
  const selectPetModel = async (modelId: string) => {
    setPetBusy(true)
    try {
      const reply = await window.memo.pet.select(modelId)
      if (reply.ok) {
        setPetState(reply.data)
        setPetMessage('已切换当前模型。')
      } else setPetMessage('切换没有完成。')
    } finally {
      setPetBusy(false)
    }
  }
  const patchSpeech = async (patch: Record<string, unknown>) => {
    setPetBusy(true)
    try {
      const reply = await window.memo.pet.setSpeechConfig(patch)
      if (reply.ok) setSpeech(reply.data)
      else setPetMessage('设置没有保存，请重试。')
    } finally {
      setPetBusy(false)
    }
  }
  const previewSpeech = async () => {
    setPetBusy(true)
    try {
      const reply = await window.memo.pet.previewSpeech()
      setPetMessage(reply.ok && reply.data.shown ? '气泡已显示在桌宠旁。' : '请先显示桌宠后再试。')
    } finally {
      setPetBusy(false)
    }
  }
  const togglePetDisplay = async (want: boolean) => {
    setPetBusy(true)
    try {
      const reply = want
        ? await window.memo.pet.show()
        : await window.memo.pet.hide()
      if (reply.ok) {
        setPetState((prev) => prev && { ...prev, display: want })
        if (want) setPetMessage('桌宠已显示在桌面上。')
      } else if (reply.error === 'UNKNOWN_MODEL')
        setPetMessage('请先把一个模型设为当前，再显示桌宠。')
      else setPetMessage('桌宠暂时无法显示。')
    } finally {
      setPetBusy(false)
    }
  }
  useEffect(() => {
    if (page === '设置') void refreshPet()
  }, [page])
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const r = await window.memo.health()
        if (active) {
          setHealth(r.ok ? r.data : null)
          setError(!r.ok)
        }
      } catch {
        if (active) {
          setHealth(null)
          setError(true)
        }
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setPage('跟进')
        setTimeout(() => searchRef.current?.focus(), 0)
      }
      if (e.key === 'Escape' && !modal) {
        setEvidence(null)
        setSelected(null)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [modal])
  const visible = (demo ? tasks : []).filter(
    (t) =>
      (filter === '全部' || t.status === filter) &&
      (project === '全部项目' || t.project === project) &&
      `${t.title}${t.project}${t.next}`.includes(query),
  )
  const current = visible.find((t) => t.id === selected)
  function choose(id: string) {
    setSelected(id)
    setDetailTab('概览')
    setEvidence(null)
  }
  function changeStatus(status: Task['status']) {
    if (!current) return
    setUndo(tasks)
    setTasks(
      tasks.map((t) =>
        t.id === current.id
          ? {
              ...t,
              status,
              next:
                status === '已完成'
                  ? '你已手动标记完成；来源条件记录保留'
                  : '已确认纳入跟进',
            }
          : t,
      ),
    )
    setNotice(
      status === '已完成'
        ? '已在示例中标记完成。原始条件记录保持不变。'
        : '已在示例中确认这件事项。',
    )
  }
  function addTask(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    const id = `sample-${Date.now()}`
    setTasks([
      ...tasks,
      {
        id,
        title: draft.trim(),
        project: '日常协作',
        status: '进行中',
        next: '手动添加，等待补充完成条件',
        date: '待定',
        source: '手动添加',
        person: '我',
        quote: '手动添加的示例事项，尚未关联来源记录。',
        conditions: [],
        events: [],
      },
    ])
    setQuery('')
    setFilter('全部')
    setProject('全部项目')
    setSelected(id)
    setDraft('')
    setModal(false)
    setUndo(null)
    setNotice('示例事项已添加，仅在本次预览中保留。')
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <strong>BUGU 不咕</strong>
        </div>
        <div className="space-label">个人工作空间</div>
        <nav aria-label="主导航">
          <AppButton
            className={page === '跟进' ? 'nav-item active' : 'nav-item'}
            aria-current={page === '跟进' ? 'page' : undefined}
            onClick={() => setPage('跟进')}
          >
            <Icon name="list" />
            跟进
            <span className="nav-count">
              {demo
                ? tasks.filter((t) => t.status !== '已完成').length
                : realCount}
            </span>
          </AppButton>
          <AppButton
            className={page === '连接' ? 'nav-item active' : 'nav-item'}
            aria-current={page === '连接' ? 'page' : undefined}
            onClick={() => setPage('连接')}
          >
            <Icon name="link" />
            连接
          </AppButton>
        </nav>
        <div className="projects">
          <div className="section-label">项目</div>
          {(demo
            ? ['全部项目', '工作台改版', '开放平台', '日常协作']
            : ['全部项目']
          ).map((p, i) => (
            <AppButton
              className={
                project === p && page === '跟进'
                  ? 'project active-project'
                  : 'project'
              }
              key={p}
              onClick={() => {
                setProject(p)
                setPage('跟进')
                setSelected(null)
              }}
            >
              <span className={`project-dot dot-${i}`} />
              {p}
            </AppButton>
          ))}
        </div>
        <div className="sidebar-foot">
          <div className="preview-label">
            <span className="tiny-dot" />
            {demo ? '设计预览' : '本地工作区'}
          </div>
          <AppButton
            className={page === '设置' ? 'nav-item active' : 'nav-item'}
            aria-current={page === '设置' ? 'page' : undefined}
            onClick={() => setPage('设置')}
          >
            <Icon name="settings" />
            设置
          </AppButton>
          <div className="profile">
            <span className="avatar">我</span>
            <div>
              个人空间<small>保存在此设备</small>
            </div>
          </div>
        </div>
      </aside>
      <WorkspacePanel>
        <header className="topbar">
          <div className="breadcrumb">
            个人空间<span>/</span>
            <strong>{page}</strong>
          </div>
          <div className="mode-switch" aria-label="数据模式">
            <AppButton
              aria-pressed={demo}
              className={demo ? 'selected' : ''}
              onClick={() => {
                setDemo(true)
                setSelected('01')
              }}
            >
              示例体验
            </AppButton>
            <AppButton
              aria-pressed={!demo}
              className={!demo ? 'selected' : ''}
              onClick={() => {
                setDemo(false)
                setProject('全部项目')
                setQuery('')
                setFilter('全部')
                setSelected(null)
                setNotice('')
                setUndo(null)
              }}
            >
              我的工作区
            </AppButton>
          </div>
        </header>
        {page === '跟进' && !demo ? (
          <RealWorkspace onCount={setRealCount} />
        ) : page === '跟进' ? (
          <>
            <div className="page-heading">
              <div>
                <h1>
                  跟进<span className="heading-dot">.</span>
                </h1>
                <p>
                  {demo
                    ? `${tasks.filter((t) => t.status === '进行中' || t.status === '等待反馈').length} 件正在跟进 · ${tasks.filter((t) => t.status === '待确认').length} 件等待你确认`
                    : '尚未添加连接'}
                </p>
              </div>
              <AppButton
                className="primary"
                onClick={() => setModal(true)}
                disabled={!demo}
              >
                <Icon name="plus" size={16} />
                添加事项
              </AppButton>
            </div>
            <div className="list-tools">
              <div className="filters" role="group" aria-label="事项筛选">
                {filters.map((f) => (
                  <AppButton
                    key={f}
                    aria-pressed={filter === f}
                    className={filter === f ? 'filter active-filter' : 'filter'}
                    onClick={() => {
                      setFilter(f)
                      setSelected(null)
                    }}
                  >
                    {f}
                    {f === '待确认' && demo && (
                      <span className="filter-count">
                        {tasks.filter((t) => t.status === f).length}
                      </span>
                    )}
                  </AppButton>
                ))}
              </div>
              <label className="search">
                <Icon name="search" size={16} />
                <AppInput
                  ref={searchRef}
                  placeholder="搜索事项"
                  aria-label="搜索事项"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setSelected(null)
                  }}
                />
                <kbd>⌘ K</kbd>
              </label>
            </div>
            <div className={`work-body ${current ? 'has-detail' : ''}`}>
              <section className="task-list" aria-label="事项列表">
                <div className="list-caption">
                  <span>
                    {project === '全部项目' ? '所有项目' : project}{' '}
                    <b>{visible.length}</b>
                  </span>
                  <span>进展与下一步</span>
                </div>
                {visible.length ? (
                  <div>
                    {visible.map((t) => (
                      <AppButton
                        key={t.id}
                        className={`task-row ${current?.id === t.id ? 'chosen' : ''}`}
                        onClick={() => choose(t.id)}
                        aria-pressed={current?.id === t.id}
                      >
                        <span className={`task-marker status-${t.status}`}>
                          {t.status === '已完成' ? (
                            <Icon name="check" size={14} />
                          ) : t.status === '等待反馈' ? (
                            <Icon name="clock" size={14} />
                          ) : t.status === '待确认' ? (
                            '?'
                          ) : null}
                        </span>
                        <span className="task-copy">
                          <span className="task-title">{t.title}</span>
                          <span className="task-next">{t.next}</span>
                          <span className="task-meta">
                            <span>{t.project}</span>
                            <span className="meta-separator">·</span>
                            {t.source}
                          </span>
                        </span>
                        <span className="task-trailing">
                          <StatusBadge status={t.status} />
                          <small>{t.date}</small>
                        </span>
                      </AppButton>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <Icon name={demo ? 'search' : 'list'} size={28} />
                    <h2>
                      {demo ? '没有匹配的事项' : '你的跟进清单，从这里开始'}
                    </h2>
                    <p>
                      {demo
                        ? '换个关键词或筛选条件试试。'
                        : '接入后，你可以在这里查看承诺、进展和来源依据。'}
                    </p>
                    <AppButton
                      className="secondary"
                      onClick={() => {
                        if (demo) {
                          setQuery('')
                          setFilter('全部')
                          setProject('全部项目')
                        } else setPage('连接')
                      }}
                    >
                      {demo ? '清除筛选' : '查看可连接的应用'}
                      <Icon name="arrow" size={16} />
                    </AppButton>
                  </div>
                )}
                <div className="list-foot">
                  {demo
                    ? '示例数据 · 所有操作仅用于设计预览'
                    : '尚未接入应用 · 当前没有采集工作记录'}
                </div>
              </section>
              {current && (
                <section className="detail" aria-label="事项详情">
                  <div className="detail-top">
                    <AppButton
                      className="icon-button"
                      aria-label="关闭详情"
                      onClick={() => setSelected(null)}
                    >
                      <Icon name="back" />
                    </AppButton>
                    <span>
                      {current.project}
                      <span className="detail-number">
                        {' '}
                        /{' '}
                        {current.id.startsWith('sample')
                          ? '手动事项'
                          : `事项 ${current.id}`}
                      </span>
                    </span>
                    <StatusBadge status={current.status} />
                  </div>
                  <div className="detail-scroll">
                    <h2>{current.title}</h2>
                    <div className="detail-meta">
                      <span className="mini-avatar">
                        {current.person.slice(0, 1)}
                      </span>
                      {current.person}
                      <span>·</span>
                      <Icon name="clock" size={14} />
                      {current.date === '待定'
                        ? '时间待确认'
                        : `${current.date}跟进`}
                    </div>
                    <div className="detail-tabs">
                      {['概览', '来源记录'].map((t) => (
                        <AppButton
                          className={detailTab === t ? 'selected-tab' : ''}
                          aria-pressed={detailTab === t}
                          key={t}
                          onClick={() => {
                            setDetailTab(t)
                            setEvidence(null)
                          }}
                        >
                          {t}
                          {t === '来源记录' && (
                            <span className="tab-count">
                              {current.events.length}
                            </span>
                          )}
                        </AppButton>
                      ))}
                    </div>
                    {detailTab === '概览' ? (
                      <>
                        <div className="next-step">
                          <div className="section-label">
                            <span className="tiny-dot" />
                            {current.status === '已完成'
                              ? '当前状态'
                              : '下一步'}
                          </div>
                          <p>{current.next}</p>
                          <small>
                            {current.status === '已完成'
                              ? '可随时回看来源与判断记录。'
                              : '尚未找到记录，不代表你没有完成。'}
                          </small>
                        </div>
                        <section className="detail-section">
                          <div className="section-heading">
                            <h3>完成条件</h3>
                            <span>
                              {current.conditions.filter((c) => c.met).length} /{' '}
                              {current.conditions.length}
                            </span>
                          </div>
                          {current.conditions.length ? (
                            current.conditions.map((c) => (
                              <div
                                className={`condition ${c.met ? 'met' : ''}`}
                                key={c.label}
                              >
                                <span className="condition-icon">
                                  {c.met ? (
                                    <Icon name="check" size={12} />
                                  ) : (
                                    <span />
                                  )}
                                </span>
                                <div>
                                  {c.label}
                                  <small>
                                    {c.met
                                      ? '已有来源记录'
                                      : '尚未找到对应记录'}
                                  </small>
                                </div>
                              </div>
                            ))
                          ) : (
                            <p className="muted">还没有约定完成条件。</p>
                          )}
                        </section>
                        <section className="detail-section">
                          <h3>最初的约定</h3>
                          <blockquote>“{current.quote}”</blockquote>
                          <div className="quote-credit">
                            {current.events.at(-1)?.app ?? '手动记录'}
                            <span> · </span>
                            {current.person}
                          </div>
                        </section>
                        <section className="detail-section">
                          <div className="section-heading">
                            <h3>最近进展</h3>
                            <AppButton
                              className="text-button"
                              onClick={() => setDetailTab('来源记录')}
                            >
                              查看全部 <Icon name="arrow" size={14} />
                            </AppButton>
                          </div>
                          {current.events.slice(0, 2).map((e, i) => (
                            <AppButton
                              className="event-compact"
                              key={e.time}
                              onClick={() => {
                                setDetailTab('来源记录')
                                setEvidence(i)
                              }}
                            >
                              <span className="event-node" />
                              <span className="event-copy">
                                <strong>{e.title}</strong>
                                <small>
                                  {e.app} · {e.time}
                                </small>
                              </span>
                              <Icon name="arrow" size={14} />
                            </AppButton>
                          ))}
                        </section>
                      </>
                    ) : (
                      <section className="evidence-list">
                        <p className="muted">
                          这些记录共同说明这件事的来处和进展。
                        </p>
                        {current.events.map((e, i) => (
                          <article
                            className={`evidence ${evidence === i ? 'expanded' : ''}`}
                            key={e.time}
                          >
                            <AppButton
                              onClick={() =>
                                setEvidence(evidence === i ? null : i)
                              }
                              aria-expanded={evidence === i}
                            >
                              <span className="source-icon">
                                <Icon name="file" size={16} />
                              </span>
                              <span className="event-copy">
                                <strong>{e.title}</strong>
                                <small>
                                  {e.app} · {e.time}
                                </small>
                              </span>
                              <span>{evidence === i ? '−' : '+'}</span>
                            </AppButton>
                            {evidence === i && (
                              <div className="evidence-content">
                                {e.body}
                                <div className="evidence-note">
                                  虚构的来源摘要，用于展示核对体验。
                                </div>
                              </div>
                            )}
                          </article>
                        ))}
                        {!current.events.length && (
                          <p className="muted">手动添加的事项尚无来源记录。</p>
                        )}
                      </section>
                    )}
                  </div>
                  <footer className="detail-actions">
                    <span>决定由你掌握</span>
                    {current.status === '已完成' ? (
                      <span className="completed-label">
                        <Icon name="check" size={16} />
                        已完成
                      </span>
                    ) : (
                      <AppButton
                        className="secondary"
                        onClick={() =>
                          changeStatus(
                            current.status === '待确认' ? '进行中' : '已完成',
                          )
                        }
                      >
                        <Icon name="check" size={16} />
                        {current.status === '待确认'
                          ? '确认跟进'
                          : '手动标记完成'}
                      </AppButton>
                    )}
                  </footer>
                </section>
              )}
            </div>
          </>
        ) : page === '连接' ? (
          <div className="standalone">
            <h1>
              应用与文件<span className="heading-dot">.</span>
            </h1>
            <p className="page-description">
              把工作发生的地方连接起来。你决定读取哪些内容。
            </p>
            <SourceImport />
            <PluginManager />
            <div className="connection-summary">
              <Icon name="link" />
              <span>可手动导入本地 JSONL 导出</span>
              <small>飞书和 GitHub 自动连接仍在开发</small>
            </div>
            <div className="section-heading">
              <h3>可接入方向</h3>
              <span>4 种来源</span>
            </div>
            {[
              ['chat', '飞书', '从授权对话中发现承诺、变更与反馈', 'blue'],
              [
                'terminal',
                '本地 AI 会话',
                '关联执行过程、工具结果和验证记录',
                'ink',
              ],
              ['github', 'GitHub', '核对 PR、提交与交付记录', 'ink'],
              ['folder', '本地文件', '从选定的文件夹中关联文档变化', 'amber'],
            ].map(([symbol, name, desc, color]) => (
              <div className="connection-row" key={name}>
                <span className={`app-icon ${color}`}>
                  <Icon name={symbol as IconName} size={20} />
                </span>
                <div>
                  <h3>{name}</h3>
                  <p>{desc}</p>
                </div>
                <span className="connection-status">未连接</span>
                <AppButton disabled className="secondary">
                  即将支持
                </AppButton>
              </div>
            ))}
            <div className="connection-note">
              <h3>每个连接，都有明确范围</h3>
              <p>
                接入时查看读取范围与数据处理方式；断开后，已有事项仍可查看。
              </p>
            </div>
          </div>
        ) : (
          <div className="standalone">
            <h1>
              设置<span className="heading-dot">.</span>
            </h1>
            <p className="page-description">查看当前设备的运行状态。</p>
            <section className="runtime">
              <div className="section-heading">
                <h2>
                  {health
                    ? '基础链路已连通'
                    : error
                      ? '核心暂不可用，正在重试'
                      : '正在连接核心'}
                </h2>
                <span className={health ? 'health-status' : 'muted'}>
                  {health ? '本地核心已就绪' : '等待连接'}
                </span>
              </div>
              <dl>
                <dt>桌面与核心通信</dt>
                <dd>{health ? '已连接' : '等待连接'}</dd>
                <dt>SQLite 版本</dt>
                <dd>{health?.sqliteVersion ?? '—'}</dd>
                <dt>数据结构版本</dt>
                <dd>{health?.schemaVersion ?? '—'}</dd>
                <dt>已接收事件 / 作业总数</dt>
                <dd>
                  {health ? `${health.eventCount} / ${health.jobCount}` : '—'}
                </dd>
              </dl>
              <p className="muted">
                当前为开发版本，事项数据库尚未加密；凭据使用独立的系统加密存储。
              </p>
            </section>
            <CredentialsPanel />
            <section className="runtime" aria-label="桌宠模型">
              <div className="section-heading">
                <h2>桌宠模型</h2>
                <span className="muted">
                  {petState
                    ? petState.currentModelId
                      ? `已选 ${petState.models.length} 个模型`
                      : `已导入 ${petState.models.length} 个模型，未选择`
                    : '读取中'}
                </span>
              </div>
              <p className="muted">
                选择包含 .model3.json 的模型目录导入。首版不支持 .cmo3
                工程文件；导入只复制校验通过的运行时资源。
              </p>
              {petState?.models.length ? (
                <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0' }}>
                  {petState.models.map((model) => (
                    <li
                      key={model.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 0',
                      }}
                    >
                      <span style={{ flex: 1 }}>
                        {model.entry}
                        {model.id === petState.currentModelId ? (
                          <span className="muted"> · 当前</span>
                        ) : null}
                      </span>
                      {model.id !== petState.currentModelId && (
                        <AppButton
                          disabled={petBusy}
                          onClick={() => void selectPetModel(model.id)}
                        >
                          设为当前
                        </AppButton>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <AppButton disabled={petBusy} onClick={() => void startPetImport()}>
                  导入模型目录
                </AppButton>
                {petState?.display ? (
                  <AppButton disabled={petBusy} onClick={() => void togglePetDisplay(false)}>
                    隐藏桌宠
                  </AppButton>
                ) : (
                  <AppButton
                    disabled={petBusy || !petState?.currentModelId}
                    onClick={() => void togglePetDisplay(true)}
                  >
                    显示桌宠
                  </AppButton>
                )}
                {petBusy ? <span className="muted">处理中…</span> : null}
              </div>
              {petMessage ? (
                <p className="muted" role="status">
                  {petMessage}
                </p>
              ) : null}
              {petIssues ? (
                <ul
                  style={{
                    listStyle: 'none',
                    padding: 0,
                    maxHeight: 160,
                    overflow: 'auto',
                  }}
                  aria-label="校验问题清单"
                >
                  {petIssues.map((issue, index) => (
                    <li key={`${issue.code}-${issue.resource}-${index}`}>
                      <span className="muted">
                        {issue.resource} — {issue.message}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
            <section className="runtime" aria-label="桌宠说话">
              <div className="section-heading">
                <h2>桌宠说话</h2>
                <span className="muted">
                  {speech
                    ? `${speech.config.enabled ? '已开启' : '已关闭'} · 今天 ${speech.todayCount}/${speech.config.dailyCap} 句`
                    : '读取中'}
                </span>
              </div>
              <p className="muted">
                偶尔用文字气泡说一句话。默认不播音；静默时段{' '}
                {speech?.config.quietStart ?? '22:00'}–
                {speech?.config.quietEnd ?? '09:00'} 内不打扰。
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <AppButton
                  disabled={petBusy}
                  onClick={() => void patchSpeech({ enabled: !(speech?.config.enabled ?? true) })}
                >
                  {speech?.config.enabled ? '关闭说话' : '开启说话'}
                </AppButton>
                <AppButton
                  disabled={petBusy}
                  onClick={() => void patchSpeech({ paused: !(speech?.config.paused ?? false) })}
                >
                  {speech?.config.paused ? '恢复' : '暂停'}
                </AppButton>
                <AppButton disabled={petBusy} onClick={() => void previewSpeech()}>
                  试一句话
                </AppButton>
                <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  频率
                  <select
                    aria-label="说话频率"
                    value={
                      speech ? (speech.config.minMinutes <= 20 ? 'high' : speech.config.minMinutes >= 90 ? 'low' : 'normal') : 'normal'
                    }
                    onChange={(event) => {
                      const ranges = { high: [20, 45], normal: [45, 90], low: [90, 150] } as const
                      const [minMinutes, maxMinutes] = ranges[event.target.value as keyof typeof ranges]!
                      void patchSpeech({ minMinutes, maxMinutes })
                    }}
                  >
                    <option value="low">低</option>
                    <option value="normal">标准</option>
                    <option value="high">高</option>
                  </select>
                </label>
                <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  静默
                  <input
                    aria-label="静默开始"
                    type="time"
                    value={speech?.config.quietStart ?? '22:00'}
                    onChange={(event) => void patchSpeech({ quietStart: event.target.value })}
                  />
                  –
                  <input
                    aria-label="静默结束"
                    type="time"
                    value={speech?.config.quietEnd ?? '09:00'}
                    onChange={(event) => void patchSpeech({ quietEnd: event.target.value })}
                  />
                </label>
              </div>
            </section>
            <div className="connection-note">
              <h3>关于设计预览</h3>
              <p>
                示例体验中的事项均为虚构。添加、确认与完成只在本次窗口中保留，不会写入数据库或修改外部应用。
              </p>
            </div>
          </div>
        )}
      </WorkspacePanel>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={16} />
          <span>{notice}</span>
          {undo && demo && (
            <AppButton
              onClick={() => {
                setTasks(undo)
                setUndo(null)
                setNotice('已撤销示例中的状态变更。')
              }}
            >
              撤销
            </AppButton>
          )}
          <AppButton
            aria-label="关闭提示"
            onClick={() => {
              setNotice('')
              setUndo(null)
            }}
          >
            <Icon name="close" size={14} />
          </AppButton>
        </div>
      )}
      <AppDialog open={modal} onOpenChange={setModal}>
        <form onSubmit={addTask}>
          <div className="section-heading">
            <DialogTitle>添加示例事项</DialogTitle>
            <AppButton
              type="button"
              className="icon-button"
              aria-label="关闭添加窗口"
              onClick={() => setModal(false)}
            >
              <Icon name="close" />
            </AppButton>
          </div>
          <DialogDescription className="muted">
            仅在本次设计预览中保留。
          </DialogDescription>
          <label className="form-label" htmlFor="task-title">
            需要跟进什么？
          </label>
          <AppInput
            id="task-title"
            value={draft}
            maxLength={100}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="例如：确认接口联调时间"
            autoFocus
            required
          />
          <div className="modal-actions">
            <AppButton
              className="secondary"
              type="button"
              onClick={() => setModal(false)}
            >
              取消
            </AppButton>
            <AppButton
              type="submit"
              className="primary"
              disabled={!draft.trim()}
            >
              添加事项
            </AppButton>
          </div>
        </form>
      </AppDialog>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

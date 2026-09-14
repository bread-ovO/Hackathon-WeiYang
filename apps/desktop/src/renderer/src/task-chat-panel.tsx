import { useEffect, useRef, useState } from 'react'
import {
  ArrowUpIcon,
  StopIcon,
  ChatCircleIcon,
  SlidersHorizontalIcon,
  XIcon,
  ListChecksIcon,
  PlusIcon,
  ArchiveIcon,
  ArrowUpRightIcon,
} from '@phosphor-icons/react'
import type { ChatSnapshot, ChatRun } from '@memo/contracts'
import {
  AppButton,
  IconButton,
  AppDialog,
  DialogTitle,
  DialogDescription,
} from './ui'
import { ModelProviderSettings } from './model-provider-settings'
import './task-chat.css'
const statusNames: Record<string, string> = {
  todo: '待办',
  in_progress: '进行中',
  waiting: '等待',
  completed: '已完成',
  cancelled: '已取消',
}
const errors: Record<string, string> = {
  MODEL_NOT_CONFIGURED: '请先配置并启用分析模型。',
  MODEL_UNAVAILABLE: '模型服务暂不可用，请检查连接后重试。',
  MODEL_CANCELLED: '本次运行已取消或超时。',
  CHAT_STEP_LIMIT: '此次查询步骤过多，请缩小范围后重试。',
  CHAT_INTERRUPTED: '应用重启中断了此次运行，可以重新发送。',
}
export function TaskChatPanel() {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [projectId, setProjectId] = useState(''),
    [snapshot, setSnapshot] = useState<ChatSnapshot>({ runs: [] }),
    [draft, setDraft] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [settingsOpen, setSettingsOpen] = useState(false)
  const bottom = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    let live = true
    void window.memo.workspace.list().then((r) => {
      if (live && r.ok) {
        setProjects(r.data.projects)
        setProjectId(r.data.projects[0]?.id ?? '')
      }
    })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    setSnapshot({ runs: [] })
    setError('')
    if (!projectId) return
    let live = true
    const refresh = () =>
      void window.memo.chat.status(projectId).then((r) => {
        if (live && r.ok) setSnapshot(r.data)
      })
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [projectId])
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [snapshot.runs.length, snapshot.runs.at(-1)?.state])
  const running = snapshot.runs.find((r) => r.state === 'running')
  async function send() {
    if (!draft.trim() || !projectId || busy || running) return
    setBusy(true)
    setError('')
    try {
      const r = await window.memo.chat.send(projectId, draft.trim())
      if (r.ok) {
        setSnapshot(r.data)
        setDraft('')
      } else setError('无法开始对话，请稍后重试。')
    } catch {
      setError('聊天服务暂不可用。')
    } finally {
      setBusy(false)
    }
  }
  async function act(run: ChatRun, kind: 'confirm' | 'reject' | 'cancel') {
    setBusy(true)
    setError('')
    try {
      const r = await window.memo.chat[kind](projectId, run.id)
      if (r.ok) setSnapshot(r.data)
      else setError('任务可能已被修改，本次未提交。请重新查询并生成建议。')
    } catch {
      setError('操作未确认，请刷新查看。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="task-chat" aria-label="AI 任务聊天">
      <header className="task-chat-header">
        <div className="task-chat-heading">
          <ChatCircleIcon size={20} aria-hidden="true" />
          <h1>和不咕聊聊</h1>
        </div>
        <label>
          项目
          <select
            aria-label="聊天项目"
            value={projectId}
            disabled={busy || !!running}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div
        className="task-chat-messages"
        role="log"
        aria-label="聊天记录"
        aria-live="polite"
      >
        {!snapshot.runs.length && (
          <div className="task-chat-empty">
            <div className="task-chat-emblem" aria-hidden="true">
              <span className="brand-mark">
                <i />
                <i />
                <i />
              </span>
            </div>
            <h2>今天，想推进哪件事？</h2>
            <p>一起理清进展，找到下一步。</p>
            <div className="task-chat-starters">
              {[
                {
                  icon: ListChecksIcon,
                  title: '看看待办',
                  hint: '还有哪些事需要跟进',
                  prompt: '有哪些任务还没完成？',
                },
                {
                  icon: PlusIcon,
                  title: '记下一件事',
                  hint: '从一个简单的任务开始',
                  prompt: '新增一个准备路演材料的任务',
                },
                {
                  icon: ArchiveIcon,
                  title: '找回任务',
                  hint: '查看回收站里的事项',
                  prompt: '查找回收站里的任务',
                },
              ].map(({ icon: Icon, title, hint, prompt }) => (
                <AppButton
                  key={title}
                  className="task-chat-starter"
                  variant="outline"
                  disabled={!projectId}
                  onClick={() => {
                    setDraft(prompt)
                    input.current?.focus()
                  }}
                >
                  <span className="task-chat-starter-content">
                    <Icon size={20} aria-hidden="true" />
                    <span className="task-chat-starter-text">
                      <strong>{title}</strong>
                      <small>{hint}</small>
                    </span>
                    <ArrowUpRightIcon
                      size={16}
                      className="task-chat-starter-arrow"
                      aria-hidden="true"
                    />
                  </span>
                </AppButton>
              ))}
            </div>
          </div>
        )}
        {snapshot.runs.map((run) => (
          <div key={run.id} className="task-chat-turn">
            <div className="task-chat-user">{run.prompt}</div>
            <article className="task-chat-assistant">
              <div className="task-chat-speaker">
                <span className="task-chat-avatar" aria-hidden="true">
                  咕
                </span>
                <strong>不咕</strong>
              </div>
              {run.reply && <p>{run.reply}</p>}
              {run.state === 'running' && (
                <p role="status">{run.trace.at(-1) || '正在思考…'}</p>
              )}
              {run.state === 'failed' && (
                <p role="alert">
                  {errors[run.error ?? ''] ||
                    '此次分析失败，请检查模型配置后重新发送。'}
                </p>
              )}
              {!!run.actions.length && (
                <div className="task-chat-proposals">
                  <p className="task-chat-proposal-heading">
                    任务变更 <span>{run.actions.length} 项</span>
                  </p>
                  {run.actions.map((a, i) => (
                    <div key={i}>
                      <span>
                        {
                          {
                            create: '新增',
                            update: '修改',
                            delete: '移入回收站',
                            restore: '恢复',
                          }[a.kind]
                        }
                      </span>
                      <strong>
                        {a.title ??
                          run.tasks.find((t) => t.id === a.taskId)?.title ??
                          a.taskId}
                      </strong>
                      {a.status && <small>状态：{statusNames[a.status]}</small>}
                      {a.dueAt !== null && (
                        <small>截止：{a.dueAt || '清空'}</small>
                      )}
                      {a.owner !== null && (
                        <small>负责人：{a.owner || '清空'}</small>
                      )}
                    </div>
                  ))}
                  {run.state === 'ready' && (
                    <div className="task-chat-proposal-actions">
                      <AppButton
                        variant="primary"
                        disabled={busy}
                        onClick={() => void act(run, 'confirm')}
                      >
                        确认执行 {run.actions.length} 项变更
                      </AppButton>
                      <AppButton
                        disabled={busy}
                        onClick={() => void act(run, 'reject')}
                      >
                        不执行
                      </AppButton>
                    </div>
                  )}
                </div>
              )}
              {['applied', 'cancelled', 'rejected'].includes(run.state) && (
                <p className="task-chat-note">
                  {run.state === 'applied'
                    ? '已执行；删除的任务可在聊天中请求恢复。'
                    : run.state === 'cancelled'
                      ? '已取消'
                      : '未执行这些变更'}
                </p>
              )}
              <details className="task-chat-trace">
                <summary>处理过程</summary>
                {run.trace.map((t, i) => (
                  <p key={i}>{t}</p>
                ))}
                {run.model && <small>{run.model.split(' (')[0]}</small>}
              </details>
            </article>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <form
        className="task-chat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        {error && <p role="alert">{error}</p>}
        <textarea
          ref={input}
          aria-label="发送给不咕"
          placeholder={
            projectId ? '问问进展，或说说你想做什么…' : '请先创建一个项目'
          }
          value={draft}
          maxLength={4000}
          disabled={!projectId || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div>
          <span className="task-chat-composer-label">
            <ChatCircleIcon size={16} aria-hidden="true" /> 询问不咕
          </span>
          <div className="task-chat-composer-actions">
            <IconButton label="模型设置" onClick={() => setSettingsOpen(true)}>
              <SlidersHorizontalIcon size={18} />
            </IconButton>
            {running ? (
              <IconButton
                label="停止生成"
                disabled={busy}
                onClick={() => void act(running, 'cancel')}
              >
                <StopIcon size={16} />
              </IconButton>
            ) : (
              <IconButton
                label="发送消息"
                variant="primary"
                disabled={busy || !projectId || !draft.trim()}
                onClick={() => void send()}
              >
                <ArrowUpIcon size={16} />
              </IconButton>
            )}
          </div>
        </div>
      </form>
      <p className="task-chat-footnote">
        变更先预览，确认后生效 <span>· Shift + Enter 换行</span>
      </p>
      <AppDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        className="task-chat-model-dialog"
      >
        <div className="task-chat-dialog-heading">
          <DialogTitle>模型设置</DialogTitle>
          <IconButton
            label="关闭模型设置"
            onClick={() => setSettingsOpen(false)}
          >
            <XIcon size={18} />
          </IconButton>
        </div>
        <DialogDescription>
          选择和不咕聊天时使用的模型服务，与事项分析共用配置。
        </DialogDescription>
        <ModelProviderSettings defaultOpen />
      </AppDialog>
    </section>
  )
}

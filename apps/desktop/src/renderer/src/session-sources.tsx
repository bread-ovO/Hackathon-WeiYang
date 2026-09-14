import { HelpTip } from './ui/help-tip'
import { ingestionErrors } from './ingestion-panel'
import { useEffect, useRef, useState } from 'react'
import type {
  CoreReply,
  SessionSourceKind,
  SourcesSnapshot,
} from '@memo/contracts'
import { AppButton } from './ui'

const kindMeta: Record<
  SessionSourceKind,
  { label: string; prefix: string; intro: string }
> = {
  'claude-code': {
    label: 'Claude Code 会话',
    prefix: 'Claude Code 会话',
    intro:
      '授权读取本机 Claude Code 的全部已有会话，分批收录到所选项目。正文仅保存在本机。',
  },
  kimi: {
    label: 'Kimi 会话',
    prefix: 'Kimi 会话',
    intro:
      '授权读取本机 Kimi Code CLI 的全部已有会话，收录带时间的用户输入与助手回复。正文仅保存在本机。',
  },
  codex: {
    label: 'Codex 会话',
    prefix: 'Codex 会话',
    intro:
      '授权读取本机 Codex 的全部已有会话（含归档），分批收录到所选项目。正文仅保存在本机。',
  },
}
const errors: Record<string, string> = {
  FILE_UNAVAILABLE: '文件不可读取',
  UNSAFE_PATH: '文件路径不安全或包含符号链接',
  FILE_TOO_LARGE: '文件超过容量限制',
  LINE_TOO_LARGE: '单行超过容量限制',
  FILE_CHANGED: '文件读取期间发生变化，请重试',
  INVALID_UTF8: '文件不是有效UTF-8',
  INVALID_JSONL: '完整行不是有效JSON',
  INVALID_SOURCE_EVENT:
    '会话格式不兼容或消息字段无效，本文件进度未推进；其他文件可继续导入',
  INVALID_CURSOR: '读取进度无效，请重新授权目录',
  INVALID_MANIFEST: '来源格式配置无效',
  SOURCE_REVISION_CONFLICT: '同一修订内容发生变化',
  IMPORT_FAILED: '导入失败，请重试',
  IMPORT_INVALID_DATA: '会话格式或字段不正确',
  IMPORT_LIMIT_EXCEEDED: '文件或记录超过容量限制',
}
function resultMessage(snapshot: SourcesSnapshot): string {
  const summary = snapshot.directoryImport
  if (!summary) return '会话目录已授权。'
  if (summary.files === 0) return '未发现本机会话，可在高级选项中指定其他目录。'
  if (summary.background)
    return `已授权 ${summary.imported} 个会话，正在后台分批读取。读取失败会显示原因。`
  let message = `发现 ${summary.files} 个会话文件，已收录 ${summary.imported} 个`
  if (summary.skipped > 0) message += `，跳过 ${summary.skipped} 个`
  if (summary.truncated) message += '；文件较多，本次仅处理前 200 个'
  return message + '。'
}
export function SessionSources({ kind }: { kind: SessionSourceKind }) {
  const meta = kindMeta[kind]
  const [data, setData] = useState<SourcesSnapshot>({ sources: [] }),
    [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [project, setProject] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const generation = useRef(0),
    pending = useRef(0),
    mounted = useRef(true)
  const revoking = useRef(new Set<string>())
  async function refresh() {
    const seq = ++generation.current
    const [s, w] = await Promise.all([
      window.memo.sources.list(),
      window.memo.workspace.list(),
    ])
    if (!mounted.current || seq !== generation.current) return
    if (s.ok) setData(s.data)
    if (w.ok) {
      setProjects(w.data.projects)
      if (w.data.projects.length === 1) setProject(w.data.projects[0]!.id)
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => {
      if (mounted.current) setMessage('本地核心暂不可用，请刷新。')
    })
    const timer = setInterval(() => {
      if (!pending.current) void refresh().catch(() => {})
    }, 3000)
    return () => {
      clearInterval(timer)
      mounted.current = false
      generation.current++
    }
  }, [])
  async function run(
    work: () => Promise<CoreReply<SourcesSnapshot>>,
    success: string | ((snapshot: SourcesSnapshot) => string),
    revokeId?: string,
  ) {
    if (revokeId ? revoking.current.has(revokeId) : pending.current > 0) return
    if (revokeId) revoking.current.add(revokeId)
    pending.current++
    setBusy(true)
    const seq = ++generation.current
    try {
      const r = await work()
      if (!mounted.current || seq !== generation.current) return
      if (r.ok) {
        setData(r.data)
        setMessage(
          r.data.cancelled
            ? '已取消，原连接保持不变。'
            : typeof success === 'string'
              ? success
              : success(r.data),
        )
      } else {
        setMessage(
          ingestionErrors[r.error] ??
            '读取未完成，请查看连接原因；已确认的进度会保留。',
        )
        await refresh()
      }
    } catch {
      if (mounted.current && seq === generation.current)
        setMessage('本地核心暂不可用，请稍后重试。')
    } finally {
      pending.current--
      if (revokeId) revoking.current.delete(revokeId)
      if (mounted.current) setBusy(pending.current > 0)
    }
  }
  const sources = data.sources.filter((s) =>
    s.displayName.startsWith(meta.prefix),
  )
  return (
    <section className="source-import" aria-label={`${meta.label}导入`}>
      <div className="source-import-actions">
        <HelpTip label={`${meta.label}授权说明`}>
          {meta.intro} 授权后扫描当前全部会话；再次授权可补齐新会话与新增内容，不重复收录。撤销停止后续读取，历史删除是单独操作。
        </HelpTip>
        <select
          aria-label="授权项目"
          value={project}
          disabled={busy}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">请选择项目</option>
          {projects.map((p) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <AppButton
          className="secondary"
          disabled={busy || !project}
          onClick={() =>
            void run(
              () => window.memo.sources.authorizeDirectory(project, kind, true),
              resultMessage,
            )
          }
        >
          授权读取本机全部会话
        </AppButton>
        <AppButton
          disabled={busy}
          onClick={() =>
            void refresh().catch(() => setMessage('刷新失败，请重试。'))
          }
        >
          刷新连接
        </AppButton>
      </div>

      <details>
        <summary>高级选项</summary>
        <AppButton
          disabled={busy || !project}
          onClick={() =>
            void run(
              () => window.memo.sources.authorizeDirectory(project, kind),
              resultMessage,
            )
          }
        >
          选择其他会话目录
        </AppButton>
      </details>
      {message && <p role="status">{message}</p>}
      {sources.length > 0 && (
        <p>
          已授权 {sources.filter((s) => s.status !== 'revoked').length} 个会话 ·
          已接收 {sources.reduce((total, s) => total + s.eventCount, 0)} 条 ·{' '}
          {sources.filter((s) => s.status === 'error').length} 个需要处理
        </p>
      )}
      <details>
        <summary>会话读取明细</summary>
        {sources.length ? (
          sources.map((s) => (
            <article className="source-import-row" key={s.id}>
              <div>
                <strong>{s.displayName}</strong>
                <p>
                  {projects.find((p) => p.id === s.projectId)?.name ?? '项目'} ·
                  已接收 {s.eventCount} 条 ·{' '}
                  {s.status === 'revoked'
                    ? '已撤销'
                    : s.status === 'error'
                      ? '需要处理'
                      : '已授权'}
                </p>
                <small>
                  {s.lastSuccessAt
                    ? `最后成功：${new Date(s.lastSuccessAt).toLocaleString()}`
                    : '尚未成功读取'}
                  {s.errorCode ? ` · ${errors[s.errorCode] ?? '导入失败'}` : ''}
                </small>
              </div>
              <div className="source-import-actions">
                <AppButton
                  className="secondary"
                  disabled={busy || s.status === 'revoked'}
                  onClick={() =>
                    void run(
                      () => window.memo.sources.sync(s.id),
                      '本批记录已接收。可继续同步后续内容。',
                    )
                  }
                >
                  继续同步
                </AppButton>
                <AppButton
                  disabled={
                    s.status === 'revoked' || revoking.current.has(s.id)
                  }
                  onClick={() =>
                    void run(
                      () => window.memo.sources.revoke(s.id),
                      '授权已撤销，后续读取已停止。历史记录保留。',
                      s.id,
                    )
                  }
                >
                  撤销授权
                </AppButton>
              </div>
            </article>
          ))
        ) : (
          <p>尚未授权会话目录。</p>
        )}
      </details>

    </section>
  )
}

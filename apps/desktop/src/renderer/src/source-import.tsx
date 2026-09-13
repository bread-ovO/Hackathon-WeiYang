import { ingestionErrors } from './ingestion-panel'
import { useEffect, useRef, useState } from 'react'
import type { CoreReply, SourcesSnapshot } from '@memo/contracts'
import { AppButton } from './ui'
const errors: Record<string, string> = {
  FILE_UNAVAILABLE: '文件不可读取',
  UNSAFE_PATH: '文件路径不安全或包含符号链接',
  FILE_TOO_LARGE: '文件超过容量限制',
  LINE_TOO_LARGE: '单行超过容量限制',
  FILE_CHANGED: '文件读取期间发生变化，请重试',
  INVALID_UTF8: '文件不是有效UTF-8',
  INVALID_JSONL: '完整行不是有效JSON',
  INVALID_SOURCE_EVENT: '缺少事件字段或角色/时间无效',
  INVALID_CURSOR: '读取进度无效，请重新选择文件',
  INVALID_MANIFEST: '来源格式配置无效',
  SOURCE_REVISION_CONFLICT: '同一修订内容发生变化，请更新revision',
  IMPORT_FAILED: '导入失败，请重试',
  IMPORT_READ_FAILED: '文件不可读取',
  IMPORT_INVALID_DATA: 'JSONL 格式或字段不正确',
  IMPORT_CHANGED: '读取期间文件发生变化，请重试',
  IMPORT_LIMIT_EXCEEDED: '文件或记录超过容量限制',
  IMPORT_CURSOR_INVALID: '读取进度无效，请重新选择文件',
}
export function SourceImport() {
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
    if (w.ok) setProjects(w.data.projects)
  }
  useEffect(() => {
    mounted.current = true
    void refresh().catch(() => {
      if (mounted.current) setMessage('本地核心暂不可用，请刷新。')
    })
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])
  async function run(
    work: () => Promise<CoreReply<SourcesSnapshot>>,
    success: string,
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
        setMessage(r.data.cancelled ? '已取消，原连接保持不变。' : success)
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
  return (
    <section className="source-import" aria-label="本地导出导入">
      <p>
        只读导入所选文件，每次最多 100
        条。正文保存在本机，当前尚未加密；不会发送给模型。
      </p>
      <div className="source-import-actions">
        <select
          aria-label="导入项目"
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
              () => window.memo.sources.chooseFile(project),
              '导出记录已接收。本地有限规则会整理候选；若已暂停，请在上方继续整理。',
            )
          }
        >
          选择 JSONL 文件
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
      <p>
        需要先在“我的工作区”创建项目。每行一个 JSON 对象，以换行结尾，字段为
        id、revision、created_at、role 和 content；role 支持
        user、assistant、tool、system。
      </p>
      <p>
        operation 可省略（默认为 upsert）。撤回须使用同一 id、新
        revision，明确填写
        <code>{' "operation":"retract","content":"" '}</code>
        ；content（正文）必须为空。仅清空正文不会被视为撤回。
      </p>
      {message && <p role="status">{message}</p>}
      {data.sources.length ? (
        data.sources.map((s) => (
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
                    '本批记录已接收。可继续同步后续完整行。',
                  )
                }
              >
                继续同步
              </AppButton>
              <AppButton
                disabled={s.status === 'revoked' || revoking.current.has(s.id)}
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
        <p>尚未选择导出文件。</p>
      )}
      <p>
        文件追加、轮转或重复选择会按修订去重。未完成的末行等待下次追加；撤销停止后续读取，历史删除是单独操作。
      </p>
    </section>
  )
}

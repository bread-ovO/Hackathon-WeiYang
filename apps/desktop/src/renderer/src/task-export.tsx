import { useRef, useState } from 'react'
import { AppButton, AppDialog, DialogTitle, DialogDescription } from './ui'

export function TaskExport({
  projects,
  selected,
  disabled,
}: {
  projects: { id: string; name: string }[]
  selected?: { id: string; projectId: string | null; title: string }
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [scope, setScope] = useState('project')
  const [includeSourceText, setIncludeSourceText] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const pending = useRef(false)
  const selectedAvailable =
    !!selected?.projectId && selected.projectId === projectId
  async function save() {
    if (
      pending.current ||
      !projectId ||
      (scope === 'selected' && !selectedAvailable)
    )
      return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const reply = await window.memo.exports.save({
        projectId,
        ...(scope === 'selected' && selected ? { taskIds: [selected.id] } : {}),
        includeSourceText,
      })
      if (reply.ok)
        setMessage(
          reply.data.cancelled
            ? '已取消保存，未生成文件。'
            : `已导出 ${reply.data.taskCount} 条事项、${reply.data.referenceCount} 条引用。`,
        )
      else
        setMessage(
          (
            {
              EXPORT_LIMIT_EXCEEDED:
                '导出内容超过容量限制，请选择单条事项后重试。',
              EXPORT_INVALID_DATA: '记录或引用不完整，未生成文件。',
              EXPORT_WRITE_FAILED: '无法保存到所选位置，请选择其他位置重试。',
              NOT_FOUND: '项目或事项已变化，请关闭后刷新。',
              CORE_UNAVAILABLE: '本地核心暂不可用，请稍后重试。',
              INVALID_REQUEST: '导出范围无效，请重新选择。',
              INTERNAL_ERROR: '导出未成功，请重试。',
              VERSION_CONFLICT: '记录已变化，请重试。',
            } as Record<string, string>
          )[reply.error] ?? '操作未成功，请重试。',
        )
    } catch {
      setMessage('导出未成功，请重试。')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <AppButton
        className="secondary"
        disabled={disabled || !projects.length}
        onClick={() => {
          setProjectId(selected?.projectId ?? projects[0]?.id ?? '')
          setScope('project')
          setIncludeSourceText(false)
          setMessage('')
          setOpen(true)
        }}
      >
        导出
      </AppButton>
      <AppDialog
        open={open}
        onOpenChange={(next) => {
          if (!pending.current) setOpen(next)
        }}
      >
        <div className="export-dialog">
          <DialogTitle>导出事项与证据</DialogTitle>
          <DialogDescription className="export-description">
            保存为 JSON 文件，保留状态、条件历史、人工决定及证据引用。
          </DialogDescription>
          <label>
            导出项目
            <select
              aria-label="导出项目"
              value={projectId}
              disabled={busy}
              onChange={(e) => {
                setProjectId(e.target.value)
                setScope('project')
                setMessage('')
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            导出范围
            <select
              aria-label="导出范围"
              value={scope}
              disabled={busy}
              onChange={(e) => {
                setScope(e.target.value)
                setMessage('')
              }}
            >
              <option value="project">项目全部事项（含归档和忽略）</option>
              {selectedAvailable && (
                <option value="selected">当前选中事项</option>
              )}
            </select>
          </label>
          <p className="export-note">
            不受列表搜索、筛选或分页影响。历史和失效证据保留原状态。
          </p>
          <label className="export-checkbox">
            <input
              type="checkbox"
              checked={includeSourceText}
              disabled={busy}
              onChange={(e) => {
                setIncludeSourceText(e.target.checked)
                setMessage('')
              }}
            />
            包含引用原文
          </label>
          <p className="export-note">
            默认仅保留引用定位。勾选后包含已保存的来源正文；导出文件为明文，请自行妥善保管。不包含应用保存的连接凭据、本地连接路径和采集进度；正文内容不会自动脱敏。
          </p>
          {message && (
            <p role="status" className="export-result">
              {message}
            </p>
          )}
          <div className="export-actions">
            <AppButton disabled={busy} onClick={() => setOpen(false)}>
              关闭
            </AppButton>
            <AppButton
              className="primary"
              disabled={
                busy ||
                !projectId ||
                (scope === 'selected' && !selectedAvailable)
              }
              onClick={() => void save()}
            >
              {busy ? '正在导出…' : '选择保存位置'}
            </AppButton>
          </div>
        </div>
      </AppDialog>
    </>
  )
}

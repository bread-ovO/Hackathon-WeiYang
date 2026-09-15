import { useEffect, useState } from 'react'
import type { WorkspaceTask } from '@memo/contracts'
import { AppButton, AppInput } from './ui'
import { Disclosure } from './ui/disclosure'
export function TaskMerge({
  task,
  disabled,
  onMerged,
  open,
}: {
  task: WorkspaceTask
  disabled: boolean
  onMerged: (task: WorkspaceTask) => void
  open?: boolean
}) {
  const [query, setQuery] = useState(''),
    [options, setOptions] = useState<WorkspaceTask[]>([]),
    [target, setTarget] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setTarget('')
    const timer = setTimeout(() => {
      if (task.projectId)
        void window.memo.workspace
          .list({
            projectId: task.projectId,
            archive: 'active',
            query,
            limit: 50,
          })
          .then((r) => {
            if (active && r.ok)
              setOptions(
                r.data.tasks.filter(
                  (t) => t.id !== task.id && t.admission !== 'ignored',
                ),
              )
          })
          .catch(() => {
            if (active) setError('读取合并目标失败')
          })
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [task.id, query])
  const selected = options.find((t) => t.id === target)
  const expectation = (t: WorkspaceTask) => ({
    projectId: t.projectId!,
    id: t.id,
    expectedVersion: t.version,
    expectedCriteriaVersion: t.criteriaVersion,
    expectedManualVersion: t.manualVersion,
  })
  return (
    <Disclosure title="合并重复事项" id="task-merge" open={open}>
      <p>
        将当前事项合并到同项目的另一事项。目标的标题、状态和截止时间保留；完成条件与证据汇入，证据重新核验。原事项归档并保留历史。
      </p>
      <AppInput
        aria-label="搜索合并目标"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={disabled || busy}
      />
      <select
        aria-label="合并到事项"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={disabled || busy}
      >
        <option value="">选择目标（最多显示 50 条，可搜索）</option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
      {selected && (
        <p>
          保留：{selected.title} · 截止时间：
          {selected.dueAt
            ? new Date(selected.dueAt).toLocaleString()
            : '未设置'}
        </p>
      )}
      <AppButton
        disabled={!selected || disabled || busy}
        onClick={async () => {
          if (!selected) return
          setBusy(true)
          setError('')
          try {
            const r = await window.memo.workspace.mergeTasks({
              ...expectation(task),
              target: expectation(selected),
            })
            if (!r.ok) {
              setError('合并失败：请刷新两条事项后重试，确认条件不超过 32 条。')
              return
            }
            const next = await window.memo.workspace.detail(
              selected.projectId!,
              selected.id,
            )
            if (next.ok) onMerged(next.data.task)
            else setError('已合并，请刷新查看目标事项。')
          } catch {
            setError('无法确认合并结果，请刷新查看。')
          } finally {
            setBusy(false)
          }
        }}
      >
        确认合并到此事项
      </AppButton>
      {error && <p role="alert">{error}</p>}
    </Disclosure>
  )
}

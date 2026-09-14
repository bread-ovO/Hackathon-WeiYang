import { useEffect, useState } from 'react'
import type { WorkspaceDetail } from '@memo/contracts'
export function TaskModelSuggestion({
  projectId,
  taskId,
}: {
  projectId: string
  taskId: string
}) {
  const [value, setValue] = useState<WorkspaceDetail['modelSuggestion']>(null)
  useEffect(() => {
    let mounted = true
    setValue(null)
    void window.memo.workspace.detail(projectId, taskId).then((r) => {
      if (mounted && r.ok) setValue(r.data.modelSuggestion)
    })
    return () => {
      mounted = false
    }
  }, [projectId, taskId])
  if (!value) return null
  return (
    <section className="candidate-provenance" aria-label="AI 分析建议">
      <h3>下一步建议</h3>
      <p>{value.candidate.nextAction || '暂无后续动作，请核对当前状态。'}</p>
      <details>
        <summary>AI 分析原文依据（{value.candidate.evidence.length}）</summary>
        <p>来自 {value.model} 的历史分析建议，不替代当前状态与人工验收。</p>
        {value.candidate.evidence.map((e, i) => (
          <blockquote key={i}>{e.quote}</blockquote>
        ))}
      </details>
    </section>
  )
}

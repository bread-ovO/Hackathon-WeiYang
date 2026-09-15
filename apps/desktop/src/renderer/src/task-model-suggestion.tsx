import type { WorkspaceDetail } from '@memo/contracts'
import { ArrowRight } from '@phosphor-icons/react'
import { HelpTip } from './ui/help-tip'
export function TaskModelSuggestion({
  value,
}: {
  value: WorkspaceDetail['modelSuggestion']
}) {
  if (!value) return null
  const stage = {
    requested: '待开始',
    in_progress: '进行中',
    delivered: '待验收',
    accepted: '原文已确认完成',
    cancelled: '原文已取消',
  }[value.candidate.stage]
  return (
    <section className="task-next-action" aria-label="AI 分析建议">
      <header>
        <h3>下一步</h3>
        <span>AI · {stage}</span>
        <HelpTip label="AI 进展说明">
          进展来自已授权内容，由 {value.model} 整理。建议不替代人工验收。
        </HelpTip>
      </header>
      {value.candidate.nextAction && (
        <p>
          <ArrowRight size={16} aria-hidden />
          <span>{value.candidate.nextAction}</span>
        </p>
      )}
      <details>
        <summary>查看来源依据 · {value.candidate.evidence.length}</summary>
        <p className="task-analysis-source">
          {value.sourceName} · {new Date(value.createdAt).toLocaleString()}
        </p>
        {value.candidate.evidence.map((e, i) => (
          <blockquote key={i}>{e.quote}</blockquote>
        ))}
      </details>
    </section>
  )
}

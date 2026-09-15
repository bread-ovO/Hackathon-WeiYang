import type { WorkspaceDetail } from '@memo/contracts'
import { ArrowRight } from '@phosphor-icons/react'
import { HelpTip } from './ui/help-tip'
export function TaskModelSuggestion({
  value,
}: {
  value: WorkspaceDetail['modelSuggestion']
}) {
  if (!value) return null
  const suggestions = [value, ...(value.related ?? [])]
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
        <span>AI · {suggestions.length > 1 ? '多个来源建议' : stage}</span>
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
        <summary>
          查看来源依据 ·{' '}
          {suggestions.reduce(
            (n, item) => n + item.candidate.evidence.length,
            0,
          )}
        </summary>
        {suggestions.map((item, index) => (
          <div key={`${item.sourceId}-${index}`}>
            <p className="task-analysis-source">
              {item.sourceName} · {new Date(item.createdAt).toLocaleString()}
              {suggestions.length > 1 && ` · ${item.candidate.title}`}
            </p>
            {item.candidate.changeKind && (
              <p className="task-analysis-source">
                最近变化：
                {
                  {
                    commitment: '承诺',
                    attempt: '尝试',
                    failure: '失败',
                    feedback: '反馈',
                    reschedule: '改期',
                    cancellation: '取消',
                  }[item.candidate.changeKind]
                }
              </p>
            )}
            {item.candidate.deadline && (
              <p className="task-analysis-source">
                原文约定：
                {new Date(item.candidate.deadline.dueAt).toLocaleString()}
                （不覆盖手动改期）
              </p>
            )}
            {item.candidate.evidence.map((e, i) => (
              <blockquote key={i}>{e.quote}</blockquote>
            ))}
          </div>
        ))}
        {value.truncated && (
          <p className="task-analysis-source">
            当前展示最近 32 组依据，更早记录保留在合并来源的原始历史中。
          </p>
        )}
      </details>
    </section>
  )
}

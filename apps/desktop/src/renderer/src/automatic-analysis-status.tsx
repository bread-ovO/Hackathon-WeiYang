import { useEffect, useState } from 'react'
import type { AnalysisSnapshot } from '@memo/contracts'
import { AppButton } from './ui'
import { HelpTip } from './ui/help-tip'

export function AutomaticAnalysisStatus({ onModelSettings, onUpdated }: {
  onModelSettings?: () => void
  onUpdated: () => void
}) {
  const [state, setState] = useState<AnalysisSnapshot | null>(null)
  useEffect(() => {
    let active = true
    let previous: string | null = null
    const poll = async () => {
      try {
        const reply = await window.memo.analysis.status()
        if (!active || !reply.ok) return
        setState(reply.data)
        if (reply.data.state === 'ready' && reply.data.runId !== previous) {
          previous = reply.data.runId
          onUpdated()
        }
      } catch { /* Keep the workspace usable if the core reconnects. */ }
    }
    void poll()
    const timer = setInterval(() => void poll(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [onUpdated])
  const failed = state?.state === 'error'
  const label = state?.state === 'running' ? '正在整理新内容' : failed
    ? state.error === 'MODEL_NOT_CONFIGURED' ? '配置 AI 模型' : '整理暂未完成'
    : '自动整理'
  return <div className="automatic-analysis-status">
    <AppButton onClick={onModelSettings}>{label}</AppButton>
    <HelpTip label="自动整理说明">已授权内容更新后自动整理，发现的事项会带来源出现在清单中，等待你确认。进展建议不会自动完成事项。仅使用已启用的模型服务；可在模型设置中停用。每小时最多整理 12 次，未变化内容不重复调用。{failed ? '当前整理遇到问题，请检查模型配置和授权，后台会稍后重试。' : ''}</HelpTip>
  </div>
}

import { ModelProviderSettings } from './model-provider-settings'
import { useEffect, useState } from 'react'
import type { AnalysisSnapshot, SourcesSnapshot } from '@memo/contracts'
import { AppButton } from './ui'

const stages = {
  requested: '待开始',
  in_progress: '推进中',
  delivered: '待验收',
  accepted: '用户已验收',
  cancelled: '用户已取消',
}
export function TaskAnalysisPanel() {
  const [sources, setSources] = useState<SourcesSnapshot | null>(null)
  const [feishu, setFeishu] = useState<{id:string;chatId:string;status:string;eventCount:number}[]>([])
  const [sourceId, setSourceId] = useState('')
  const [state, setState] = useState<AnalysisSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let mounted = true
    void window.memo.sources.list().then((r) => {
      if (mounted && r.ok) setSources(r.data)
    })
    void window.memo.feishu.list().then(r => { if(mounted && r.ok) setFeishu(r.data.connections) })
    const refresh = () => {
      void window.memo.analysis.status().then((r) => {
        if (mounted && r.ok) setState(r.data)
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      mounted = false
      window.clearInterval(timer)
    }
  }, [])
  const running = busy || state?.state === 'running'
  async function start() {
    setBusy(true)
    setError('')
    try {
      const r = await window.memo.analysis.start(sourceId)
      if (r.ok) setState(r.data)
      else setError('无法开始分析，请确认会话仍授权且已有记录。')
    } catch {
      setError('分析服务暂不可用。')
    } finally {
      setBusy(false)
    }
  }
  async function accept(index: number) {
    if (!state?.runId) return
    setBusy(true)
    setError('')
    try {
      const r = await window.memo.analysis.accept(state.runId, index)
      if (r.ok) setState(r.data)
      else setError('会话可能已更新，请重新分析后确认。')
    } catch {
      setError('加入结果未确认，请刷新查看。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="source-import" aria-label="AI 事项分析">
      <p>
        理解会话里的需求、补充与交付，整理出下一步。使用你选择的模型服务，确认后加入跟进。
      </p>
      <ModelProviderSettings />
      <div className="source-import-actions">
        <label>
          选择已授权会话{' '}
          <select
            aria-label="选择分析会话"
            value={sourceId}
            disabled={running}
            onChange={(e) => setSourceId(e.target.value)}
          >
            <option value="">请选择会话</option>
            {sources?.sources
              .filter((s) => s.status !== 'revoked' && s.eventCount > 0)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}（{s.eventCount} 条）
                </option>
              ))}
            {feishu.filter(s=>s.status!=='revoked'&&s.status!=='paused'&&s.eventCount>0).map(s=><option key={s.id} value={s.id}>飞书会话 {s.chatId}（{s.eventCount} 条）</option>)}
          </select>
        </label>
        <AppButton
          variant="primary"
          disabled={!sourceId || running}
          onClick={() => void start()}
        >
          {running ? '正在理解会话…' : '分析会话'}
        </AppButton>
      </div>
      {state && state.state !== 'idle' && (
        <p>
          本次读取 {state.messageCount} 条消息
          {state.truncated ? '，仅分析最近的有限上下文' : ''}
          。{state.state === 'ready' ? `分析服务：${state.model.split(' (')[0]}。` : ''}模型判断待复核，不自动完成事项。
        </p>
      )}
      {(error || state?.state === 'error') && (
        <p role="alert">
          {error ||
            (state?.error === 'ANALYSIS_CONTEXT_CHANGED'
              ? '会话在分析期间已更新，请重新分析。'
              : state?.error === 'MODEL_NOT_CONFIGURED'
                ? '请展开「分析模型」，配置并启用一个模型服务。'
                : state?.error === 'MODEL_AUTH_REQUIRED'
                  ? '模型服务拒绝授权，请检查 API Key。'
                  : state?.error === 'MODEL_RATE_LIMITED'
                    ? '模型服务额度或速率受限，请稍后重试。'
                    : state?.error === 'MODEL_CLI_FAILED'
                      ? 'CLI 调用失败，请确认该工具已登录、额度可用且版本支持非交互分析。'
                      : '模型分析未成功，请检查模型配置或 CLI 登录状态后重试。')}
        </p>
      )}
      {state?.state === 'ready' && state.result?.tasks.length === 0 && (
        <p>这段会话没有识别到需要跟进的事项。</p>
      )}
      {state?.state === 'ready' &&
        state.result?.tasks.map((task, index) => (
          <article
            key={index}
            style={{
              padding: '24px 0',
              borderTop: '1px solid var(--line, #e5e5e5)',
            }}
          >
            <div
              className="source-import-actions"
              style={{ justifyContent: 'space-between' }}
            >
              <h3>{task.title}</h3>
              <span>{stages[task.stage]}</span>
            </div>
            <p>
              下一步：{task.nextAction || '暂无下一步，请核对原文与当前状态'}
            </p>
            <div className="source-import-actions">
              <AppButton
                disabled={running || state.accepted.includes(index)}
                onClick={() => void accept(index)}
              >
                {state.accepted.includes(index) ? '已加入跟进' : '确认加入跟进'}
              </AppButton>
              <details>
                <summary>查看原文依据（{task.evidence.length}）</summary>
                {task.evidence.map((e, i) => (
                  <blockquote key={i}>{e.quote}</blockquote>
                ))}
              </details>
            </div>
          </article>
        ))}
    </section>
  )
}

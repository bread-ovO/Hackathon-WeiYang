import { HelpTip } from './ui/help-tip'
import { useEffect, useRef, useState } from 'react'
import type { ProcessingStatus } from '@memo/contracts'
import { AppButton } from './ui'
const labels = {
  idle: '等待新记录',
  running: '正在处理记录',
  paused: '已暂停',
  error: '处理需要检查',
} as const
export function ProcessingPanel() {
  const [status, setStatus] = useState<ProcessingStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(false),
    generation = useRef(0),
    mutating = useRef(false)
  async function refresh() {
    if (mutating.current) return
    const seq = ++generation.current
    try {
      const result = await window.memo.processing.status()
      if (!mounted.current || seq !== generation.current) return
      if (result.ok) {
        setStatus(result.data)
        setMessage('')
      } else setMessage('整理状态读取失败，请刷新。')
    } catch {
      if (mounted.current && seq === generation.current)
        setMessage('本地核心暂不可用，请刷新。')
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, 3000)
    return () => {
      mounted.current = false
      generation.current++
      window.clearInterval(timer)
    }
  }, [])
  async function configure() {
    if (!status || mutating.current) return
    mutating.current = true
    generation.current++
    setBusy(true)
    setMessage('')
    try {
      const result = await window.memo.processing.configure(!status.enabled)
      if (!mounted.current) return
      if (result.ok) setStatus(result.data)
      else setMessage('设置未确认，请刷新后查看实际状态。')
    } catch {
      if (mounted.current)
        setMessage('设置结果需要确认，请刷新后查看实际状态。')
    } finally {
      mutating.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="source-import" aria-label="后台整理">
      <div className="connection-label">
        <h2>后台整理</h2>
        <HelpTip label="后台整理说明">
          已授权记录通过启用的 AI
          模型提取并复核任务，带原文来源进入待确认清单。暂停会停止后续整理并取消正在运行的分析，已有任务保留。下方计数表示记录接收处理进度，AI
          分析状态在跟进页查看。
        </HelpTip>
      </div>
      <div className="source-import-actions">
        <strong>{status ? labels[status.state] : '正在读取状态…'}</strong>
        <AppButton disabled={!status || busy} onClick={() => void configure()}>
          {status?.enabled ? '暂停整理' : '继续整理'}
        </AppButton>
        <AppButton disabled={busy} onClick={() => void refresh()}>
          刷新整理状态
        </AppButton>
      </div>
      {status && (
        <p>
          待处理 {status.pendingCount} · 已处理记录 {status.processedCount} ·
          待复核记录（历史累计） {status.reviewRequiredCount}
        </p>
      )}
      {status && status.reviewRequiredCount > 0 && (
        <p>
          待复核记录尚未自动应用。有关联事项的修订可在事项详情查看；未关联事项的记录需对照来源人工处理。
        </p>
      )}
      {status?.lastProcessedAt && (
        <p>最近处理：{new Date(status.lastProcessedAt).toLocaleString()}</p>
      )}
      {status?.errorCode && (
        <p role="alert">
          部分记录处理失败，原记录仍保留。当前没有手动重试入口，可暂停整理并查看来源状态。
        </p>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { ProcessingStatus } from '@memo/contracts'
import { AppButton } from './ui'
const labels = {
  idle: '等待新记录',
  running: '正在整理',
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
    <section className="source-import" aria-label="本地候选整理">
      <h2>本地候选整理</h2>
      <p>
        自动整理已授权收录的记录，只按有限规则提取明确承诺，生成待确认候选。全程在本机运行，不联网推理，不修改已收录事项或自动标记完成。
      </p>
      <p>默认开启。暂停会停止后续处理，已生成的候选与原文引用保留。</p>
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
          待处理 {status.pendingCount} · 已处理 {status.processedCount} ·
          已生成候选（累计）{status.candidateCount} · 待复核记录（历史累计）{' '}
          {status.reviewRequiredCount}
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

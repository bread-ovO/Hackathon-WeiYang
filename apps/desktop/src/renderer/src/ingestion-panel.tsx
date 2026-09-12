import { useEffect, useRef, useState } from 'react'
import type { IngestionStatus } from '@memo/contracts'
import { AppButton, AppInput } from './ui'
const reasons = {
  queue_limit: '待处理队列已达上限，等待本地整理释放队列或调整限额。',
  database_limit: '数据库与 WAL 已达容量预算，可调整限额后继续。',
  disk_low: '磁盘可用空间不足，请释放磁盘空间后刷新。',
  probe_unavailable: '无法确认磁盘用量，已暂停接收。请检查本地存储状态后刷新。',
} as const
export const ingestionErrors: Record<string, string> = {
  INGESTION_QUEUE_LIMIT: reasons.queue_limit,
  INGESTION_DATABASE_LIMIT: reasons.database_limit,
  INGESTION_DISK_LOW: reasons.disk_low,
  INGESTION_PROBE_UNAVAILABLE: reasons.probe_unavailable,
}
const MiB = 1048576
function size(bytes: number | null) {
  return bytes === null ? '不可读取' : `${(bytes / MiB).toFixed(1)} MiB`
}
export function IngestionPanel() {
  const [status, setStatus] = useState<IngestionStatus | null>(null)
  const [queue, setQueue] = useState(''),
    [database, setDatabase] = useState(''),
    [free, setFree] = useState('')
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const mounted = useRef(false),
    pending = useRef(false),
    generation = useRef(0)
  function apply(value: IngestionStatus) {
    setStatus(value)
    setQueue(String(value.limits.maxQueuedJobs))
    setDatabase(String(value.limits.maxDatabaseBytes / MiB))
    setFree(String(value.limits.minFreeDiskBytes / MiB))
  }
  async function refresh() {
    if (pending.current) return
    const seq = ++generation.current
    setBusy(true)
    try {
      const r = await window.memo.ingestion.status()
      if (!mounted.current || seq !== generation.current) return
      if (r.ok) {
        apply(r.data)
        setMessage('')
      } else setMessage('预算读取失败，请刷新。')
    } catch {
      if (mounted.current && seq === generation.current)
        setMessage('本地核心暂不可用，请刷新。')
    } finally {
      if (mounted.current && seq === generation.current) setBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])
  async function save() {
    if (pending.current) return
    const patch = {
      maxQueuedJobs: Number(queue),
      maxDatabaseBytes: Number(database) * MiB,
      minFreeDiskBytes: Number(free) * MiB,
    }
    if (
      !Number.isInteger(patch.maxQueuedJobs) ||
      patch.maxQueuedJobs < 1 ||
      patch.maxQueuedJobs > 100000 ||
      !Number.isSafeInteger(patch.maxDatabaseBytes) ||
      patch.maxDatabaseBytes < MiB ||
      patch.maxDatabaseBytes > 8192 * MiB ||
      !Number.isSafeInteger(patch.minFreeDiskBytes) ||
      patch.minFreeDiskBytes < MiB ||
      patch.minFreeDiskBytes > 16384 * MiB
    ) {
      setMessage(
        '请输入范围内的预算：队列 1–100000，数据库 1–8192 MiB，磁盘低水位 1–16384 MiB。',
      )
      return
    }
    pending.current = true
    generation.current++
    setBusy(true)
    setMessage('')
    try {
      const r = await window.memo.ingestion.configure(patch)
      if (!mounted.current) return
      if (r.ok) {
        apply(r.data)
        setMessage('预算已保存，已接收数据保留。')
      } else setMessage('预算未确认，请刷新查看实际设置。')
    } catch {
      if (mounted.current) setMessage('保存结果需要确认，请刷新查看实际设置。')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="source-import" aria-label="收录预算">
      <h2>收录预算</h2>
      <p>
        超过预算时暂停新增记录，不删除已收录数据，也不提前推进读取进度。单批记录整批提交；若一批新增记录超过队列额度，需提高额度后再同步。预算恢复后，已启用插件继续自动采样；本地文件可点击继续同步。
      </p>
      {status && (
        <>
          <strong>
            {status.paused ? '新增收录已暂停' : '预算允许继续收录'}
          </strong>
          {status.reason && <p role="status">{reasons[status.reason]}</p>}
          <p>
            待处理与处理中：{status.pendingCount} /{' '}
            {status.limits.maxQueuedJobs} 条
          </p>
          <p>
            数据库与 WAL：{size(status.databaseBytes)} /{' '}
            {size(status.limits.maxDatabaseBytes)}
          </p>
          <p>
            磁盘可用：{size(status.freeDiskBytes)} · 最低保留：
            {size(status.limits.minFreeDiskBytes)}
          </p>
        </>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="source-import-actions">
          <label>
            队列上限（条）
            <AppInput
              aria-label="队列上限"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={queue}
              disabled={!status || busy}
              onChange={(e) => setQueue(e.target.value)}
            />
          </label>
          <label>
            数据库预算（MiB）
            <AppInput
              aria-label="数据库预算"
              type="number"
              min={1}
              max={8192}
              step="any"
              value={database}
              disabled={!status || busy}
              onChange={(e) => setDatabase(e.target.value)}
            />
          </label>
          <label>
            磁盘低水位（MiB）
            <AppInput
              aria-label="磁盘低水位"
              type="number"
              min={1}
              max={16384}
              step="any"
              value={free}
              disabled={!status || busy}
              onChange={(e) => setFree(e.target.value)}
            />
          </label>
          <AppButton type="submit" disabled={!status || busy}>
            保存收录预算
          </AppButton>
        </div>
      </form>
      <AppButton disabled={busy} onClick={() => void refresh()}>
        刷新预算状态
      </AppButton>
      {message && <p role="alert">{message}</p>}
    </section>
  )
}

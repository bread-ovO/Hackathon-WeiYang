import { useEffect, useRef, useState } from 'react'
import type { ReferenceSummary } from '@memo/contracts'
import { AppButton } from './ui'
import { ReferenceReviewPanel } from './reference-review'
const statusText = {
  available: '原始引用',
  review_required: '引用版本待复核',
  confirmed: '已确认使用指定版本',
  invalidated: '引用已失效',
} as const
export function ReferenceList({
  projectId,
  taskId,
  onConfirmed,
}: {
  projectId: string
  taskId: string
  onConfirmed: () => void
}) {
  const [references, setReferences] = useState<ReferenceSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const epoch = useRef(0),
    pending = useRef(false)
  async function load(after?: string) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    const seq = epoch.current
    try {
      const result = await window.memo.workspace.listReferences({
        projectId,
        taskId,
        limit: 50,
        ...(after ? { cursor: after } : {}),
      })
      if (seq !== epoch.current) return
      if (result.ok) {
        setReferences((old) =>
          after
            ? [
                ...old,
                ...result.data.references.filter(
                  (r) => !old.some((x) => x.kind === r.kind && x.id === r.id),
                ),
              ]
            : result.data.references,
        )
        setCursor(result.data.nextCursor)
      } else setError('引用列表读取失败。')
    } catch {
      if (seq === epoch.current) setError('本地核心暂不可用。')
    } finally {
      if (seq === epoch.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  useEffect(() => {
    epoch.current++
    setReferences([])
    setCursor(null)
    pending.current = false
    void load()
    return () => {
      epoch.current++
    }
  }, [projectId, taskId])
  return (
    <section aria-label="引用版本复核" className="reference-review">
      <h3>引用版本复核</h3>
      <AppButton disabled={busy} onClick={() => void load()}>
        刷新可复核引用
      </AppButton>
      {references.map((r) => (
        <div key={`${r.kind}:${r.id}`}>
          <p>
            {r.kind === 'manual' ? '人工条件引用' : '候选来源引用'} · 原始事件 #
            {r.eventId} · {statusText[r.status]}
            {r.originalReferenceStatus === 'invalidated'
              ? ' · 原始引用保持失效'
              : ''}
          </p>
          <ReferenceReviewPanel
            scope={{
              projectId,
              taskId,
              referenceKind: r.kind,
              referenceId: r.id,
            }}
            onConfirmed={() => {
              onConfirmed()
              void load()
            }}
          />
        </div>
      ))}
      {!references.length && !busy && !error && <p>没有可复核的引用。</p>}
      {cursor && (
        <AppButton disabled={busy} onClick={() => void load(cursor)}>
          加载更多引用
        </AppButton>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}

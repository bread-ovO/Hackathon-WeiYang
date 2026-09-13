import { useEffect, useRef, useState } from 'react'
import type { ReferenceReview } from '@memo/contracts'
import { AppButton, AppInput } from './ui'
import './reference-review.css'

const roleLabels = {
  user: '用户',
  assistant: '助手',
  tool: '工具',
  system: '系统',
} as const
type Scope = {
  projectId: string
  taskId: string
  referenceKind: 'processing' | 'manual'
  referenceId: string
}
export function ReferenceReviewPanel({
  scope,
  onConfirmed,
}: {
  scope: Scope
  onConfirmed: () => void
}) {
  const [review, setReview] = useState<ReferenceReview | null>(null)
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const [selected, setSelected] = useState(''),
    [reason, setReason] = useState('')
  const active = useRef(true),
    pending = useRef(false),
    generation = useRef(0)
  const scopeKey = JSON.stringify(scope)
  useEffect(() => {
    active.current = true
    generation.current++
    pending.current = false
    setBusy(false)
    setReview(null)
    setOpened(false)
    setSelected('')
    setReason('')
    setMessage('')
    return () => {
      active.current = false
      generation.current++
    }
  }, [scopeKey])
  async function load(cursor?: string) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    const seq = ++generation.current
    try {
      const result = await window.memo.workspace.reviewReference({
        ...scope,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      })
      if (!active.current || seq !== generation.current) return
      if (result.ok) {
        setReview((old) =>
          cursor &&
          old &&
          old.knownContentSetDigest === result.data.knownContentSetDigest
            ? {
                ...result.data,
                events: [
                  ...old.events,
                  ...result.data.events.filter(
                    (e) => !old.events.some((p) => p.id === e.id),
                  ),
                ],
              }
            : result.data,
        )
        if (!cursor) setSelected('')
        setOpened(true)
      } else setMessage('引用版本读取失败，请刷新。')
    } catch {
      if (active.current && seq === generation.current)
        setMessage('本地核心暂不可用。')
    } finally {
      if (active.current && seq === generation.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  async function confirm() {
    if (
      pending.current ||
      !review ||
      !selected ||
      !reason.trim() ||
      review.reference.status === 'invalidated'
    )
      return
    pending.current = true
    setBusy(true)
    setMessage('')
    const seq = ++generation.current
    try {
      const reply = await window.memo.workspace.confirmReference({
        ...scope,
        chosenEventId: Number(selected),
        knownContentSetDigest: review.knownContentSetDigest,
        expectedReferenceVersion: review.reference.version,
        reason: reason.trim(),
      })
      if (!active.current || seq !== generation.current) return
      if (reply.ok) {
        setReview(reply.data)
        setMessage('已确认使用此版本，仅影响当前引用；事项业务状态未更改。')
        onConfirmed()
      } else
        setMessage(
          '确认未完成，引用或已知版本可能已变化。请刷新版本列表后重新检查。',
        )
    } catch {
      if (active.current && seq === generation.current)
        setMessage('确认结果需要核对，请刷新版本列表；请勿直接重复提交。')
    } finally {
      if (active.current && seq === generation.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  const event = review?.events.find((e) => String(e.id) === selected)
  return (
    <section
      className="reference-review"
      aria-label={`引用版本复核 ${scope.referenceKind} ${scope.referenceId}`}
    >
      <div className="source-import-actions">
        <AppButton disabled={busy} onClick={() => void load()}>
          {opened ? '刷新版本列表' : '复核引用版本'}
        </AppButton>
        {opened && (
          <AppButton disabled={busy} onClick={() => setOpened(false)}>
            收起版本复核
          </AppButton>
        )}
      </div>
      {opened && review && (
        <>
          <p>
            这里只列出已收录的已知版本，不代表平台最新版本。确认只为当前引用指定使用的整条消息，原始引用仍保留。
          </p>
          {review.confirmation && (
            <div className="reference-confirmation">
              <strong>
                {review.reference.status === 'confirmed'
                  ? '已确认使用此版本'
                  : review.reference.status === 'invalidated'
                    ? '历史确认（当前已失效）'
                    : '历史确认（当前需重新复核）'}{' '}
                · 修订 {review.confirmation.revision} ·{' '}
                {roleLabels[review.confirmation.role]}
              </strong>
              <blockquote>{review.confirmation.text}</blockquote>
              <p>确认依据：{review.confirmation.reason}</p>
              <p>
                所选消息状态：
                {
                  {
                    available: '可供参考，尚未核验',
                    valid: '人工判定有效',
                    unknown: '尚未核验',
                    invalid: '已失效',
                  }[review.confirmation.validity]
                }
              </p>
              <p>
                确认时间：
                {new Date(review.confirmation.createdAt).toLocaleString()} ·
                操作者：{review.confirmation.actorId}
              </p>
            </div>
          )}
          {review.reference.status === 'review_required' && (
            <p role="status">
              引用版本待复核：已知内容发生变化，原有确认不再适用，请重新选择具体版本。
            </p>
          )}
          {review.reference.status === 'invalidated' && (
            <p role="status">
              该引用已失效，不能通过版本确认恢复。请核对撤回依据或原始失效决定。
            </p>
          )}
          <label>
            选择已知版本
            <select
              aria-label="选择已知版本"
              disabled={busy || review.reference.status === 'invalidated'}
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">请选择具体版本</option>
              {review.events.map((e) => (
                <option key={e.id} value={e.id}>
                  修订 {e.revision} · {roleLabels[e.role]} · 事件 #{e.id}
                </option>
              ))}
            </select>
          </label>
          {event && (
            <div>
              <p>
                待确认的整条消息 · {roleLabels[event.role]} · 来源标注时间：
                {new Date(event.occurredAt).toLocaleString()}
              </p>
              <blockquote>{event.text}</blockquote>
            </div>
          )}
          {review.nextCursor && (
            <AppButton
              disabled={busy}
              onClick={() => void load(review.nextCursor!)}
            >
              加载更多已知版本
            </AppButton>
          )}
          <label>
            确认依据
            <AppInput
              aria-label="确认依据"
              maxLength={512}
              value={reason}
              disabled={busy || review.reference.status === 'invalidated'}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <AppButton
            disabled={
              busy ||
              !event ||
              !reason.trim() ||
              review.reference.status === 'invalidated'
            }
            onClick={() => void confirm()}
          >
            确认使用所选版本
          </AppButton>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}

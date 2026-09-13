/** A deliberately narrow local grammar, not a model or a completion judgement. */
export const EXPLICIT_COMMITMENT_VERSION = 'explicit-commitment-v1' as const
export const MAX_EXPLICIT_COMMITMENTS = 8
export interface ExplicitCommitment {
  /** Position within this immutable event revision; never a cross-revision identity. */
  key: string
  title: string
  dueAt: null
  /** UTF-16 offsets into the original event text, including the commitment wording. */
  quoteStart: number
  quoteEnd: number
}
export interface ExplicitCommitmentResult {
  outcome: 'candidates' | 'ignored' | 'needs_review'
  reason:
    | 'explicit_commitment'
    | 'non_user_role'
    | 'no_explicit_commitment'
    | 'plan_change'
    | 'candidate_limit'
    | 'source_retracted'
  candidates: ExplicitCommitment[]
}
export function extractExplicitCommitments(input: {
  text: string
  role: string
  operation?: 'upsert' | 'retract'
}): ExplicitCommitmentResult {
  if (
    !input ||
    typeof input.text !== 'string' ||
    input.text.length > 65536 ||
    !['user', 'assistant', 'tool', 'system'].includes(input.role)
  )
    throw new Error('INVALID_COMMITMENT_INPUT')
  const result = (
    outcome: ExplicitCommitmentResult['outcome'],
    reason: ExplicitCommitmentResult['reason'],
  ): ExplicitCommitmentResult => ({ outcome, reason, candidates: [] })
  if (
    input.operation !== undefined &&
    !['upsert', 'retract'].includes(input.operation)
  )
    throw new Error('INVALID_COMMITMENT_INPUT')
  if (input.operation === 'retract') {
    if (input.text !== '') throw new Error('INVALID_COMMITMENT_INPUT')
    return result('needs_review', 'source_retracted')
  }
  if (input.role !== 'user') return result('ignored', 'non_user_role')
  if (
    /^\s*(?:示例|例子|引用|转述|他说|她说|example|quote)\s*[:：]/iu.test(
      input.text,
    )
  )
    return result('ignored', 'no_explicit_commitment')
  const candidates: ExplicitCommitment[] = []
  let offset = 0,
    fence: string | null = null
  for (const raw of input.text.split('\n')) {
    const start = offset
    offset += raw.length + 1
    const line = raw.trim()
    const marker = /^(?:```+|~~~+)/.exec(line)?.[0]
    if (marker) {
      if (!fence) fence = marker[0]!
      else if (marker[0] === fence) fence = null
      continue
    }
    if (
      fence ||
      /^(?:\t| {4}|\s*>)/.test(raw) ||
      !line ||
      /[\u0000-\u001f\u007f]/u.test(line) ||
      /[<>`"“”「」『』]/u.test(line)
    )
      continue
    if (/[?？]|[吗么吧]$|示例|举例|假设/u.test(line)) continue
    if (
      /(?:改期|延期|取消|改到|改为|截止.{0,20}(?:调整|改))|\b(?:cancel|reschedule|postpone)\b/iu.test(
        line,
      )
    )
      return result('needs_review', 'plan_change')
    if (
      /(?:如果|假如|也许|可能|尽量|尝试|希望|考虑|不一定|不会|不再|不要|不能|没有|未能|是否|会不会|能否|要不要|已经|已完成|完成了)|\b(?:if|maybe|might|try|not|never|already)\b/iu.test(
        line,
      )
    )
      continue
    const chinese =
      /^(?:我(?:会|将|来|负责)|由我负责)\s*((?:提交|发送|反馈|修复|实现|编写|整理|补充|更新|提供|交付|完成|检查|确认|联系|准备|设计|测试|处理).+)$/u.exec(
        line,
      )
    const english =
      /^I (?:will|shall) ((?:submit|send|fix|implement|write|prepare|deliver|review|test|update|provide|finish|contact)\s+.+)$/iu.exec(
        line,
      )
    const match = chinese ?? english
    if (!match) continue
    const title = match[1]!.replace(/[。.!！]+$/u, '').trim()
    if (title.length < 3 || title.length > 256) continue
    const quoteStart = start + raw.indexOf(line)
    candidates.push({
      key: String(quoteStart),
      title,
      dueAt: null,
      quoteStart,
      quoteEnd: quoteStart + line.length,
    })
    if (candidates.length > MAX_EXPLICIT_COMMITMENTS)
      return result('needs_review', 'candidate_limit')
  }
  return candidates.length
    ? { outcome: 'candidates', reason: 'explicit_commitment', candidates }
    : result('ignored', 'no_explicit_commitment')
}

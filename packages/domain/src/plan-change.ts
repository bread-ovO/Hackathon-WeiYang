import { parseContextTimestamp } from './context'
/** Bounded opt-in grammar: one explicit absolute deadline, no relative-date or semantic inference. */
export function extractExplicitPlanChange(input: {
  text: string
  role: string
  operation?: 'upsert' | 'retract'
}): {
  dueAt: string
  quoteStart: number
  quoteEnd: number
  quote: string
} | null {
  if (
    input.role !== 'user' ||
    input.operation === 'retract' ||
    typeof input.text !== 'string' ||
    input.text.length > 240 ||
    /[\r\n\t]/u.test(input.text)
  )
    return null
  const match =
    /^(?:我将)?截止时间改为[ ]+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))[。！!]?$/u.exec(
      input.text,
    )
  if (!match) return null
  try {
    const parsed = parseContextTimestamp(match[1])
    return {
      dueAt: new Date(parsed.utc).toISOString(),
      quoteStart: 0,
      quoteEnd: input.text.length,
      quote: input.text,
    }
  } catch {
    return null
  }
}

/** Conservative calendar parsing in the occurrence timestamp's explicit offset.
 * A date without a clock means the end of that local day. Ambiguity stays null. */
export function resolveDeadline(
  text: string,
  occurredAt: string,
): string | null {
  const epoch = Date.parse(occurredAt)
  const zone = /(Z|([+-])(\d{2}):?(\d{2}))$/.exec(occurredAt)
  if (!Number.isFinite(epoch) || !zone) return null
  const offset =
    zone[1] === 'Z'
      ? 0
      : (zone[2] === '-' ? -1 : 1) * (Number(zone[3]) * 60 + Number(zone[4]))
  if (Math.abs(offset) > 14 * 60 || Number(zone[4] ?? 0) > 59) return null
  const local = new Date(epoch + offset * 60_000)
  const days = [
    ...text.matchAll(
      /\d{4}-\d{2}-\d{2}|今天|明天|后天|(?:下周|本周|周|星期)[一二三四五六日天]/g,
    ),
  ]
  if (days.length !== 1 || /可能|大概|左右|或者|或是|之后|以后/.test(text))
    return null
  const before = text.slice(0, days[0]!.index).trim(),
    after = text.slice(days[0]!.index! + days[0]![0].length)
  const leading = /^(?:(?:我(?:会|将|来|负责)|由我负责)\s*)?(?:在)?$/.test(
    before,
  )
  const marked =
    /截止(?:时间)?[：:\s]*$/.test(before) ||
    /^(?:(?:上午|下午|晚上|中午|凌晨)?\s*\d{1,2}(?::\d{2}|点(?:半|\d{1,2}分)?))?(?:之前|前)/.test(
      after,
    )
  if ((!leading && !marked) || after.startsWith('的')) return null
  const token = days[0]![0]
  const day = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  )
  if (/^\d/.test(token)) {
    const parsed = new Date(token + 'T00:00:00Z')
    if (
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== token
    )
      return null
    day.setTime(parsed.getTime())
  } else if (['今天', '明天', '后天'].includes(token))
    day.setUTCDate(day.getUTCDate() + ['今天', '明天', '后天'].indexOf(token))
  else {
    const target = '一二三四五六日'.indexOf(token.at(-1)!.replace('天', '日'))
    const weekday = (day.getUTCDay() + 6) % 7
    const delta = token.startsWith('下周')
      ? 7 - weekday + target
      : token.startsWith('本周')
        ? target - weekday
        : (target - weekday + 7) % 7
    day.setUTCDate(day.getUTCDate() + delta)
  }
  if (/\d{3,}[:点]|:\d{3,}|\d{1,2}:\d(?!\d)/.test(text)) return null
  const clocks = [
    ...text.matchAll(
      /(?:(上午|下午|晚上|中午|凌晨)\s*)?(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分|半)?)/g,
    ),
  ]
  if (clocks.length > 1) return null
  let hour = 23,
    minute = 59,
    second = 59,
    millis = 999
  if (clocks.length) {
    const m = clocks[0]!
    hour = Number(m[2])
    minute = Number(m[3] ?? m[4] ?? (m[0].endsWith('半') ? 30 : 0))
    second = 0
    millis = 0
    if (m[1]) {
      if (hour < 1 || hour > 12) return null
      if (m[1] === '上午' && hour === 12) return null
      if (['下午', '晚上'].includes(m[1]) && hour < 12) hour += 12
      if (m[1] === '中午' && hour < 11) return null
      if (m[1] === '凌晨' && hour === 12) hour = 0
    }
    if (hour > 23 || minute > 59) return null
  } else if (/上午|下午|晚上|中午|凌晨/.test(text)) return null
  day.setUTCHours(hour, minute, second, millis)
  return new Date(day.getTime() - offset * 60_000).toISOString()
}

import Ajv from 'ajv'
export const idSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
} as const
export const dateSchema = { type: 'string', format: 'date-time' } as const
export const nullableDateSchema = {
  anyOf: [dateSchema, { type: 'null' }],
} as const
export const nullableIdSchema = { anyOf: [idSchema, { type: 'null' }] } as const
export const ajv = new Ajv({ allErrors: true })
export function isDateTime(value: string): boolean {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    )
  if (!m || !Number.isFinite(Date.parse(value))) return false
  const [year, month, day, hour, minute, second] = m
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number]
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    hour < 24 &&
    minute < 60 &&
    second < 60 &&
    (!m[7] || (Number(m[8]) < 24 && Number(m[9]) < 60))
  )
}
ajv.addFormat('date-time', { type: 'string', validate: isDateTime })

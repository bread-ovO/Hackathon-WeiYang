import { createHash } from 'node:crypto'
import type { SourceEventV2 } from '@memo/contracts'
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  const record = value as Record<string, unknown>
  return (
    '{' +
    Object.keys(record)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(record[k]))
      .join(',') +
    '}'
  )
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
export function factIdentity(event: SourceEventV2): unknown {
  const { adapterVersion: _version, ...provenance } = event.provenance
  return {
    ...event,
    provenance,
    timeBasis: {
      kind: event.timeBasis.kind,
      timeZone: event.timeBasis.timeZone,
    },
    occurredAt:
      event.occurredAt === null
        ? null
        : new Date(event.occurredAt).toISOString(),
    sourceUpdatedAt:
      event.sourceUpdatedAt === null
        ? null
        : new Date(event.sourceUpdatedAt).toISOString(),
  }
}
export const bytes = (value: unknown): number =>
  Buffer.byteLength(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  )
export function requireId(value: string): void {
  if (typeof value !== 'string' || !value.length || value.length > 256)
    throw new Error('INVALID_ID')
}

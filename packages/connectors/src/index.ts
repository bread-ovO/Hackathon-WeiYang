import type { SourceEvent } from '@memo/contracts'
export interface SourceAdapter {
  readonly kind:string
  // The host grants scope before creating an adapter. No implementation is enabled yet.
  pull(cursor:string, signal:AbortSignal): Promise<{events:SourceEvent[]; nextCursor:string}>
}

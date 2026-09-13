import {
  parseSourceEvent,
  parseSourcePage,
  type SourceEvent,
  type Receipt,
  type Checkpoint,
  type IngestionContext,
} from '@memo/contracts'
export * from './search'
export * from './jobs'
export interface EventStore {
  receive(event: SourceEvent, cursor: string): { inserted: boolean }
}
// Connectors submit data, not SQL or state changes. The adapter is responsible for authorization.
export function receiveEvent(
  store: EventStore,
  input: unknown,
  cursor: string,
): { inserted: boolean } {
  if (cursor.length > 4096) throw new Error('CURSOR_TOO_LARGE')
  return store.receive(parseSourceEvent(input), cursor)
}

export interface PageStore {
  checkpoint(sourceId: string, streamId: string): Checkpoint
  receivePage(input: unknown, context: IngestionContext): Receipt
}
export interface PullAdapter {
  pull(cursor: string, signal: AbortSignal): Promise<unknown>
}
export async function ingestNextPage(
  store: PageStore,
  adapter: PullAdapter,
  context: IngestionContext,
  streamId: string,
  batchId: string,
  signal: AbortSignal,
): Promise<Receipt> {
  signal.throwIfAborted()
  const cp = store.checkpoint(context.sourceInstanceId, streamId)
  if (cp.scopeEpoch !== context.scopeEpoch)
    throw new Error('STALE_AUTHORIZATION')
  const raw = await adapter.pull(cp.cursor, signal)
  signal.throwIfAborted()
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !['events', 'nextCursor'].includes(k))
  )
    throw new Error('INVALID_SOURCE_PAGE')
  const response = raw as { events: unknown; nextCursor: unknown }
  const page = parseSourcePage({
    sourceInstanceId: context.sourceInstanceId,
    streamId,
    scopeEpoch: context.scopeEpoch,
    batchId,
    expectedCursorVersion: cp.version,
    nextCursor: response.nextCursor,
    events: response.events,
  })
  return store.receivePage(page, context)
}

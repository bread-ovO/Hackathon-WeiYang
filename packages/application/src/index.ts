import { parseSourceEvent, type SourceEvent } from '@memo/contracts'
interface EventStore {
  receive(event:SourceEvent, cursor:string): { inserted:boolean }
}
// Connectors submit data, not SQL or state changes. The adapter is responsible for authorization.
export function receiveEvent(store:EventStore, input:unknown, cursor:string): { inserted:boolean } {
  if (cursor.length > 4096) throw new Error('CURSOR_TOO_LARGE')
  return store.receive(parseSourceEvent(input), cursor)
}

export { prepareEventProcessing } from './event-processing'
export type { PreparedEventProcessing } from './event-processing'

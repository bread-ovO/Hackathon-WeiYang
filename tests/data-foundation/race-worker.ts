import { openFoundationStore as openStore } from '@memo/storage/foundation'
import { NOW, probe, event, page } from './fixtures'
const [path, mode, owner] = process.argv.slice(2)
if (!path || !owner || !['page', 'claim'].includes(mode!))
  throw new Error('INVALID_TEST_ARGUMENTS')
const store = openStore(path, { now: () => NOW, probe })
// Prepare the same cursor version before all contenders cross the parent barrier.
const input = page(store, [event(1, 'race-' + owner)], 'race-' + owner)
process.once('message', () => {
  try {
    const value =
      mode === 'page'
        ? store.receivePage(input, {
            sourceInstanceId: 'source',
            scopeEpoch: 2,
          })
        : store.claimJob(owner, ['v1'], 60000)
    process.send?.({ type: 'result', ok: true, value })
  } catch (error) {
    process.send?.({
      type: 'result',
      ok: false,
      code: (error as Error).message,
    })
  } finally {
    store.close()
    process.disconnect()
  }
})
process.send?.({ type: 'ready' })

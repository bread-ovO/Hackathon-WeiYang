import { prepareEventProcessing } from '@memo/application'
import type { ProcessingStatus } from '@memo/contracts'
import type { openStore } from '@memo/storage'
import { createProcessingLoop } from './processing-loop'

export function createLocalProcessing(store: ReturnType<typeof openStore>) {
  let serviceError = false
  const loop = createProcessingLoop({
    isEnabled: () => store.processing.isEnabled(),
    runOne() {
      const lease = store.processing.claim()
      serviceError = false
      if (!lease) return false
      try {
        const context = store.processing.load(lease)
        if (!context) {
          store.processing.release(lease)
          return false
        }
        const proposal = prepareEventProcessing({
          event: context.event,
          eventId: context.eventId,
          projectId: context.projectId,
        })
        store.processing.commit(lease, context, proposal)
        serviceError = false
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (
          code === 'PROCESSING_DISABLED' ||
          code === 'PROCESSING_SOURCE_CHANGED'
        ) {
          store.processing.release(lease)
        } else if (code !== 'PROCESSING_LEASE_LOST') {
          const invalid =
            /^INVALID_(?:PROCESSING|COMMITMENT|CONTEXT|SOURCE)/u.test(code)
          if (
            !store.processing.fail(
              lease,
              invalid ? 'INVALID_OUTPUT' : 'EXECUTION_FAILED',
              !invalid,
            )
          )
            store.processing.release(lease)
        }
      }
      return true
    },
    onError() {
      serviceError = true
    },
  })
  function status(): ProcessingStatus {
    const value = store.processing.getStatus()
    const failed = serviceError || value.failed > 0
    return {
      enabled: value.enabled,
      state: !value.enabled
        ? 'paused'
        : failed
          ? 'error'
          : value.running > 0 || value.pending > 0
            ? 'running'
            : 'idle',
      pendingCount: value.pending + value.running,
      processedCount: value.processed,
      candidateCount: value.candidates,
      reviewRequiredCount: value.reviewRequired,
      lastProcessedAt: value.lastProcessedAt,
      errorCode: failed ? 'PROCESSING_FAILED' : null,
    }
  }
  return {
    start: loop.start,
    dispose: loop.dispose,
    status,
    configure(enabled: boolean) {
      store.processing.setEnabled(enabled)
      loop.wake()
      return status()
    },
  }
}

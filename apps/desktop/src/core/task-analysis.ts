import type { AnalysisRequest, AnalysisSnapshot } from '@memo/contracts'
import { analyzeTasks, TASK_ANALYSIS_VERSION } from '@memo/model'
import type { openStore } from '@memo/storage'
import { localTaskModelTransport } from './task-model-transport'

export function createTaskAnalysisService(store: ReturnType<typeof openStore>) {
  let state: AnalysisSnapshot = {
    state: 'idle',
    error: null,
    runId: null,
    sourceId: null,
    model: 'qwen2.5:7b',
    messageCount: 0,
    truncated: false,
    result: null,
    accepted: [],
  }
  let controller: AbortController | undefined
  const latest = store.taskAnalysis.latest(TASK_ANALYSIS_VERSION)
  if (latest)
    state = {
      ...state,
      ...latest,
      state: 'ready',
      accepted: store.taskAnalysis.accepted(latest.runId),
    }
  function snapshot() {
    return structuredClone(state)
  }
  return {
    handle(request: AnalysisRequest) {
      if (request.method === 'analysis.status') return snapshot()
      if (request.method === 'analysis.accept') {
        if (state.state !== 'ready' || state.runId !== request.runId)
          throw new Error('INVALID_REQUEST')
        store.taskAnalysis.accept(request.runId, request.index)
        state.accepted = store.taskAnalysis.accepted(request.runId)
        return snapshot()
      }
      if (state.state === 'running') return snapshot()
      const context = store.taskAnalysis.context(request.sourceId)
      controller = new AbortController()
      state = {
        ...state,
        state: 'running',
        error: null,
        runId: null,
        sourceId: request.sourceId,
        result: null,
        accepted: [],
        messageCount: context.messages.length,
        truncated: context.truncated,
      }
      void analyzeTasks({
        messages: context.messages,
        transport: localTaskModelTransport,
        signal: controller.signal,
      })
        .then((result) => {
          const runId = store.taskAnalysis.save(
            context,
            result,
            state.model,
            TASK_ANALYSIS_VERSION,
          )
          state = {
            ...state,
            state: 'ready',
            runId,
            result: store.taskAnalysis.read(runId),
            accepted: store.taskAnalysis.accepted(runId),
          }
        })
        .catch((error) => {
          const code = error instanceof Error ? error.message : ''
          state = {
            ...state,
            state: 'error',
            error: [
              'MODEL_TIMEOUT',
              'INVALID_TASK_ANALYSIS',
              'ANALYSIS_CONTEXT_CHANGED',
              'MODEL_CANCELLED',
            ].includes(code)
              ? code
              : 'MODEL_UNAVAILABLE',
          }
        })
      return snapshot()
    },
    dispose() {
      controller?.abort()
    },
  }
}

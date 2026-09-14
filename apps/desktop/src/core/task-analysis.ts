import type { AnalysisRequest, AnalysisSnapshot } from '@memo/contracts'
import { analyzeTasks, TASK_ANALYSIS_VERSION } from '@memo/model'
import type { openStore } from '@memo/storage'
import type { TaskModelRequest } from '@memo/model'

export function createTaskAnalysisService(
  store: ReturnType<typeof openStore>,
  infer: (
    input: TaskModelRequest,
  ) => Promise<{ content: string; model: string }>,
) {
  let state: AnalysisSnapshot = {
    state: 'idle',
    error: null,
    runId: null,
    sourceId: null,
    model: '尚未分析',
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
        transport: async (input) => {
          const response = await infer(input)
          state.model = response.model
          return response.content
        },
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
              'MODEL_NOT_CONFIGURED',
              'MODEL_AUTH_REQUIRED',
              'MODEL_RATE_LIMITED',
              'MODEL_CLI_MISSING',
              'MODEL_CLI_FAILED',
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

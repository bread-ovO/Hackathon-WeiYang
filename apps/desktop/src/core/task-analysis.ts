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
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let providerRetryAt = 0
  const retryAfter = new Map<string, number>()
  function tick() {
    if (disposed) return
    try {
      if (
        store.processing.isEnabled() &&
        state.state !== 'running' &&
        Date.now() >= providerRetryAt
      ) {
        const next = store.taskAnalysis
          .pending(TASK_ANALYSIS_VERSION)
          .find((item) => (retryAfter.get(item.sourceId) ?? 0) <= Date.now())
        if (next) {
          // Serialize model calls, retry failures at most once per five minutes/source.
          retryAfter.set(next.sourceId, Date.now() + 300_000)
          service.handle(
            { method: 'analysis.start', sourceId: next.sourceId },
            true,
            next.afterEventId,
          )
        }
      }
    } catch {
      // A transient storage/source error must never stop the core process.
    } finally {
      if (!disposed) timer = setTimeout(tick, 30_000)
    }
  }
  const service = {
    cancel() {
      controller?.abort()
    },
    start() {
      if (!timer && !disposed) timer = setTimeout(tick, 10_000)
    },
    handle(request: AnalysisRequest, automatic = false, afterEventId = 0) {
      if (request.method === 'analysis.status') return snapshot()
      if (request.method === 'analysis.accept') {
        if (state.state !== 'ready' || state.runId !== request.runId)
          throw new Error('INVALID_REQUEST')
        store.taskAnalysis.accept(request.runId, request.index)
        state.accepted = store.taskAnalysis.accepted(request.runId)
        return snapshot()
      }
      if (state.state === 'running') return snapshot()
      let context: ReturnType<typeof store.taskAnalysis.context>
      try {
        context = store.taskAnalysis.context(
          request.sourceId,
          afterEventId,
          TASK_ANALYSIS_VERSION,
        )
      } catch (error) {
        if (!automatic) throw error
        retryAfter.set(request.sourceId, Date.now() + 300_000)
        state = {
          ...state,
          state: 'error',
          sourceId: request.sourceId,
          error:
            error instanceof Error &&
            error.message === 'ANALYSIS_MESSAGE_TOO_LARGE'
              ? error.message
              : 'ANALYSIS_CONTEXT_CHANGED',
          result: null,
          runId: null,
          accepted: [],
        }
        return snapshot()
      }
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
        knownTasks: context.knownTasks,
        transport: async (input) => {
          // Recheck authorization before BOTH extraction and review requests.
          const current = store.taskAnalysis.context(
            context.sourceId,
            context.afterEventId,
            TASK_ANALYSIS_VERSION,
            context.endEventId,
          )
          if (current.fingerprint !== context.fingerprint)
            throw new Error('ANALYSIS_CONTEXT_CHANGED')
          if (automatic && !store.processing.isEnabled())
            throw new Error('MODEL_CANCELLED')
          const response = await infer(input)
          state.model = response.model
          return response.content
        },
        signal: controller.signal,
      })
        .then((result) => {
          if (disposed) return
          if (automatic && !store.processing.isEnabled())
            throw new Error('MODEL_CANCELLED')
          const runId = (
            automatic ? store.taskAnalysis.discover : store.taskAnalysis.save
          )(context, result, state.model, TASK_ANALYSIS_VERSION)
          retryAfter.delete(request.sourceId)
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
          if (automatic && code !== 'MODEL_CANCELLED')
            providerRetryAt = Date.now() + 300_000
          if (code === 'MODEL_CANCELLED' && !store.processing.isEnabled()) {
            retryAfter.delete(request.sourceId)
            providerRetryAt = 0
            state = { ...state, state: 'idle', error: null }
            return
          }
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
              'ANALYSIS_SOURCE_UNAVAILABLE',
              'ANALYSIS_MESSAGE_TOO_LARGE',
              'MODEL_CANCELLED',
            ].includes(code)
              ? code
              : 'MODEL_UNAVAILABLE',
          }
        })
      return snapshot()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      controller?.abort()
    },
  }
  return service
}

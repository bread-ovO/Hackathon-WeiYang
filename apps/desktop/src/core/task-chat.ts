import { buildTaskDraft } from './task-drafts'
import { runTaskChat, type TaskModelRequest } from '@memo/model'
import type { ChatRequest, ChatSnapshot } from '@memo/contracts'
import type { openStore } from '@memo/storage'
export function createTaskChatService(
  store: ReturnType<typeof openStore>,
  infer: (
    request: TaskModelRequest,
  ) => Promise<{ content: string; model: string }>,
) {
  const active = new Map<string, AbortController>()
  store.taskChat.recover()
  const snapshot = (projectId: string): ChatSnapshot => ({
    runs: store.taskChat.list(projectId),
  })
  return {
    handle(request: ChatRequest): ChatSnapshot {
      if (request.method === 'chat.draft') {
        const draft = buildTaskDraft(store, request.projectId, request.kind)
        const run = store.taskChat.start(
          request.projectId,
          request.kind === 'daily'
            ? '生成近 24 小时回顾草稿'
            : '生成项目反馈草稿',
        )
        store.taskChat.finishDraft(run.id, request.projectId, draft)
        return snapshot(request.projectId)
      }
      if (request.method === 'chat.status') return snapshot(request.projectId)
      if (request.method === 'chat.confirm') {
        store.taskChat.confirm(request.runId, request.projectId)
        return snapshot(request.projectId)
      }
      if (
        request.method === 'chat.cancel' ||
        request.method === 'chat.reject'
      ) {
        store.taskChat.read(request.runId, request.projectId)
        active.get(request.runId)?.abort()
        store.taskChat.cancel(
          request.runId,
          request.projectId,
          request.method === 'chat.reject',
        )
        return snapshot(request.projectId)
      }
      if (active.size) throw Error('CHAT_BUSY')
      const history = store.taskChat
        .list(request.projectId)
        .slice(-8)
        .map((r) => ({ user: r.prompt, assistant: r.reply, state: r.state }))
      const run = store.taskChat.start(request.projectId, request.message)
      const controller = new AbortController()
      active.set(run.id, controller)
      const timer = setTimeout(() => controller.abort(), 180000)
      const initial = store.taskChat.search(request.projectId, '')
      void runTaskChat({
        prompt: request.message,
        history,
        initial,
        signal: controller.signal,
        infer,
        search: (query) => store.taskChat.search(request.projectId, query),
        get: (id) => store.taskChat.get(request.projectId, id),
        trace: (step) => store.taskChat.trace(run.id, request.projectId, step),
      })
        .then((result) => {
          if (controller.signal.aborted) throw Error('MODEL_CANCELLED')
          store.taskChat.finish(
            run.id,
            request.projectId,
            result.output,
            result.observed,
            result.model,
          )
        })
        .catch((error) =>
          store.taskChat.fail(
            run.id,
            request.projectId,
            error instanceof Error &&
              /^(MODEL_|CHAT_|NOT_FOUND|VERSION_CONFLICT)/.test(error.message)
              ? error.message
              : 'CHAT_FAILED',
          ),
        )
        .finally(() => {
          clearTimeout(timer)
          active.delete(run.id)
        })
      return snapshot(request.projectId)
    },
    dispose() {
      for (const c of active.values()) c.abort()
    },
  }
}

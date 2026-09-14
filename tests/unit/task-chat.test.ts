import { describe, it, expect } from 'vitest'
import {
  parseChatOutput,
  parseCoreRequest,
  type ChatOutput,
  type ChatTask,
} from '@memo/contracts'
import { runTaskChat } from '@memo/model'
const answer: ChatOutput = {
  message: '没有待办',
  tool: 'answer',
  query: '',
  taskId: '',
  actions: [],
}
const task: ChatTask = {
  id: 'one',
  title: '修复登录',
  status: 'todo',
  version: 1,
  criteriaVersion: 0,
  manualVersion: 0,
  dueAt: null,
  owner: null,
  deleted: false,
}
describe('task agent runner', () => {
  it('validates a closed tool/action surface', () => {
    expect(() =>
      parseChatOutput(JSON.stringify({ ...answer, tool: 'execute_shell' })),
    ).toThrow()
    expect(() =>
      parseCoreRequest({
        method: 'chat.send',
        projectId: 'a',
        message: 'hi',
        path: '/tmp',
      }),
    ).toThrow()
    expect(() =>
      parseChatOutput(
        JSON.stringify({
          ...answer,
          actions: [
            {
              kind: 'delete',
              taskId: 'one',
              title: null,
              status: null,
              dueAt: null,
              owner: null,
            },
          ],
        }),
      ),
    ).toThrow()
  })
  it('feeds actual scoped tool output back before answering', async () => {
    let calls = 0
    const result = await runTaskChat({
      prompt: '找登录任务',
      history: [],
      initial: { items: [] },
      signal: new AbortController().signal,
      trace: () => {},
      search: (q) => {
        expect(q).toBe('登录')
        return { items: [task], note: 'bounded' }
      },
      get: () => task,
      infer: async (r) => {
        expect(r.purpose).toBe('task-chat')
        calls++
        if (calls === 1)
          return {
            content: JSON.stringify({
              ...answer,
              tool: 'search_tasks',
              query: '登录',
            }),
            model: 'fixture',
          }
        expect(r.messages.at(-1)?.content).toContain('修复登录')
        return {
          content: JSON.stringify({ ...answer, message: '找到了修复登录任务' }),
          model: 'fixture',
        }
      },
    })
    expect(calls).toBe(2)
    expect(result.observed).toEqual([task])
  })
  it('bounds tool loops', async () => {
    let calls = 0
    await expect(
      runTaskChat({
        prompt: 'test',
        history: [],
        initial: { items: [] },
        signal: new AbortController().signal,
        trace: () => {},
        search: () => ({ items: [], note: '' }),
        get: () => task,
        infer: async () => {
          calls++
          return {
            model: 'fixture',
            content: JSON.stringify({ ...answer, tool: 'search_tasks' }),
          }
        },
      }),
    ).rejects.toThrow('CHAT_STEP_LIMIT')
    expect(calls).toBe(4)
  })
  it('does not call provider after cancellation', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      runTaskChat({
        prompt: 'test',
        history: [],
        initial: { items: [] },
        signal: abort.signal,
        trace: () => {},
        search: () => ({ items: [], note: '' }),
        get: () => task,
        infer: async () => {
          throw Error('should not run')
        },
      }),
    ).rejects.toThrow('MODEL_CANCELLED')
  })
})

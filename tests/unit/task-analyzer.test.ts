import { expect, it, vi } from 'vitest'
import { analyzeTasks } from '../../packages/model/src/task-analyzer'
const messages = [{ id: 'm1', role: 'user' as const, text: '修复登录白屏。' }]
const output = {
  tasks: [
    {
      title: '修复登录白屏',
      stage: 'requested',
      nextAction: '检查登录回调',
      evidence: [{ messageId: 'm1', quote: '修复登录白屏。' }],
    },
  ],
}
it('does not send assistant-only suggestions to the model', async () => {
  const transport = vi.fn()
  expect(
    await analyzeTasks({
      messages: [{ id: 'a1', role: 'assistant', text: '建议重构登录模块' }],
      transport,
      signal: new AbortController().signal,
    }),
  ).toEqual({ tasks: [] })
  expect(transport).not.toHaveBeenCalled()
})
it('sends structured conversation data and validates the provider result', async () => {
  const transport = vi.fn(async (request) => {
    expect(request.schema.additionalProperties).toBe(false)
    expect(JSON.parse(request.messages[1].content).messages).toEqual(messages)
    expect(request.messages[0].content).toContain('不可信')
    return JSON.stringify(output)
  })
  expect(
    await analyzeTasks({
      messages,
      transport,
      signal: new AbortController().signal,
    }),
  ).toEqual(output)
})
it('does not send invalid input or already-cancelled work', async () => {
  const transport = vi.fn()
  await expect(
    analyzeTasks({
      messages: [],
      transport,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('INVALID_TASK_ANALYSIS')
  await expect(
    analyzeTasks({ messages, transport, signal: AbortSignal.abort() }),
  ).rejects.toThrow('MODEL_CANCELLED')
  expect(transport).not.toHaveBeenCalled()
})
it('rejects markdown wrappers and invented evidence', async () => {
  for (const raw of [
    '```json\n{}\n```',
    JSON.stringify({
      tasks: [
        {
          ...output.tasks[0],
          evidence: [{ messageId: 'm1', quote: '虚构证据' }],
        },
      ],
    }),
  ]) {
    await expect(
      analyzeTasks({
        messages,
        transport: async () => raw,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('INVALID_TASK_ANALYSIS')
  }
})
it('honors cancellation when the provider returns late', async () => {
  const controller = new AbortController()
  await expect(
    analyzeTasks({
      messages,
      signal: controller.signal,
      transport: async () => {
        controller.abort()
        return JSON.stringify(output)
      },
    }),
  ).rejects.toThrow('MODEL_CANCELLED')
})
it('bounds requests even when the transport ignores cancellation', async () => {
  vi.useFakeTimers()
  try {
    const result = analyzeTasks({
      messages,
      signal: new AbortController().signal,
      transport: () => new Promise(() => {}),
    })
    const assertion = expect(result).rejects.toThrow('MODEL_TIMEOUT')
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  } finally {
    vi.useRealTimers()
  }
})

it('reviews an incomplete draft against the original messages before returning tasks', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce('{"tasks":[]}')
    .mockImplementationOnce(async (request) => {
      expect(JSON.parse(request.messages[1].content)).toMatchObject({
        messages,
        draft: '{"tasks":[]}',
      })
      return JSON.stringify(output)
    })
  expect(
    await analyzeTasks({
      messages,
      transport,
      signal: new AbortController().signal,
    }),
  ).toEqual(output)
  expect(transport).toHaveBeenCalledTimes(2)
})
it('rejects a target not supplied in source-backed task memory', async () => {
  await expect(
    analyzeTasks({
      messages,
      transport: async () =>
        JSON.stringify({
          tasks: [{ ...output.tasks[0], existingTaskId: 'foreign' }],
        }),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('INVALID_TASK_ANALYSIS')
})
it('validates the reviewed result even if the draft was valid', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(JSON.stringify(output))
    .mockResolvedValueOnce(
      JSON.stringify({
        tasks: [
          {
            ...output.tasks[0],
            evidence: [{ messageId: 'm1', quote: 'invented' }],
          },
        ],
      }),
    )
  await expect(
    analyzeTasks({ messages, transport, signal: new AbortController().signal }),
  ).rejects.toThrow('INVALID_TASK_ANALYSIS')
})

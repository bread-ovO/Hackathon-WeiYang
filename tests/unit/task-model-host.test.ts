import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { taskExtractionSchema, taskChatOutputSchema } from '@memo/contracts'
const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('../../apps/desktop/node_modules/electron', () => ({
  utilityProcess: { fork },
}))
import type { TaskModelRequest } from '@memo/model'
import { CoreClient } from '../../apps/desktop/src/main/core-client'

it('the desktop host uses the strict extraction schema and never a schema supplied over IPC', async () => {
  const child = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(),
    kill: vi.fn(),
  })
  fork.mockReturnValue(child)
  const client = new CoreClient('/synthetic/core.js', '/synthetic/test.sqlite')
  const infer = vi.fn(async (_input: TaskModelRequest) => ({
    content: '{"tasks":[]}',
    model: 'fixture',
  }))
  client.modelHandler = infer
  client.start()
  try {
    child.emit('message', {
      kind: 'model.analyze',
      id: 'extract',
      messages: [{ role: 'user', content: 'synthetic' }],
      schema: { untrusted: true },
    })
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(1))
    expect(infer.mock.calls[0]?.[0]).toMatchObject({
      schema: taskExtractionSchema,
    })
    const item = taskExtractionSchema.properties.tasks.items
    expect([...item.required].sort()).toEqual(
      Object.keys(item.properties).sort(),
    )
    child.emit('message', {
      kind: 'model.analyze',
      id: 'chat',
      purpose: 'task-chat',
      messages: [{ role: 'user', content: 'synthetic' }],
    })
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2))
    expect(infer.mock.calls[1]?.[0]).toMatchObject({
      schema: taskChatOutputSchema,
    })
  } finally {
    client.stop()
  }
})

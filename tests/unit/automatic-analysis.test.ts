import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskAnalysisService } from '../../apps/desktop/src/core/task-analysis'
import type { openStore } from '@memo/storage'

function fixture(failure = false) {
  const task = {title:'整理材料',stage:'requested',nextAction:'准备材料',evidence:[{messageId:'m1',quote:'请整理材料'}]}
  let done = false
  const analysis = {
    latest: () => null,
    pending: () => done ? [] : [{sourceId:'source',fingerprint:'first'}],
    context: () => ({sourceId:'source', messages:[{id:'m1',role:'user',text:'请整理材料'}], truncated:false}),
    discover: vi.fn(() => { done=true; return 'run' }),
    read: () => ({tasks:[task]}), accepted: () => [0],
  }
  const infer = vi.fn(async () => {
    if (failure) throw new Error('MODEL_AUTH_REQUIRED')
    return { content: JSON.stringify({tasks:[task]}), model:'fixture' }
  })
  const service = createTaskAnalysisService({taskAnalysis:analysis} as unknown as ReturnType<typeof openStore>, infer)
  return { service, infer, analysis }
}
afterEach(() => vi.useRealTimers())
describe('automatic analysis', () => {
  it('starts without UI, materializes once, and stops on disposal', async () => {
    vi.useFakeTimers()
    const {service,infer,analysis} = fixture()
    service.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(infer).toHaveBeenCalledTimes(1)
    expect(analysis.discover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(infer).toHaveBeenCalledTimes(1)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('backs off provider errors instead of retrying every scan', async () => {
    vi.useFakeTimers()
    const {service,infer,analysis} = fixture(true)
    service.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(infer).toHaveBeenCalledTimes(1)
    expect(analysis.discover).not.toHaveBeenCalled()
    expect(service.handle({method:'analysis.status'}).error).toBe('MODEL_AUTH_REQUIRED')
    service.dispose()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTaskAnalysisService } from '../../apps/desktop/src/core/task-analysis'
import type { openStore } from '@memo/storage'

function fixture(failure = false) {
  const task = {
    title: '整理材料',
    stage: 'requested',
    nextAction: '准备材料',
    evidence: [{ messageId: 'm1', quote: '请整理材料' }],
  }
  let done = false
  const processing = { enabled: true, isEnabled: () => processing.enabled }
  const analysis = {
    latest: () => null,
    pending: () => (done ? [] : [{ sourceId: 'source', fingerprint: 'first' }]),
    context: () => ({
      sourceId: 'source',
      messages: [{ id: 'm1', role: 'user', text: '请整理材料' }],
      truncated: false,
    }),
    discover: vi.fn(() => {
      done = true
      return 'run'
    }),
    read: () => ({ tasks: [task] }),
    accepted: () => [0],
  }
  const infer = vi.fn(async () => {
    if (failure) throw new Error('MODEL_AUTH_REQUIRED')
    return { content: JSON.stringify({ tasks: [task] }), model: 'fixture' }
  })
  const service = createTaskAnalysisService(
    { taskAnalysis: analysis, processing } as unknown as ReturnType<
      typeof openStore
    >,
    infer,
  )
  return { service, infer, analysis, processing }
}
afterEach(() => vi.useRealTimers())
describe('automatic analysis', () => {
  it('starts without UI, materializes once, and stops on disposal', async () => {
    vi.useFakeTimers()
    const { service, infer, analysis } = fixture()
    service.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(infer).toHaveBeenCalledTimes(2)
    expect(analysis.discover).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(infer).toHaveBeenCalledTimes(2)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('backs off provider errors instead of retrying every scan', async () => {
    vi.useFakeTimers()
    const { service, infer, analysis } = fixture(true)
    service.start()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(infer).toHaveBeenCalledTimes(1)
    expect(analysis.discover).not.toHaveBeenCalled()
    expect(service.handle({ method: 'analysis.status' }).error).toBe(
      'MODEL_AUTH_REQUIRED',
    )
    service.dispose()
  })
})

it('does not infer while paused and fences an in-flight result when paused', async () => {
  vi.useFakeTimers()
  const { service, infer, analysis, processing } = fixture()
  processing.enabled = false
  service.start()
  await vi.advanceTimersByTimeAsync(40_000)
  expect(infer).not.toHaveBeenCalled()
  processing.enabled = true
  let complete: (value: { content: string; model: string }) => void = () => {}
  infer.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  await vi.advanceTimersByTimeAsync(30_000)
  expect(infer).toHaveBeenCalledTimes(1)
  processing.enabled = false
  service.cancel()
  complete({ content: '{"tasks":[]}', model: 'fixture' })
  await vi.advanceTimersByTimeAsync(1)
  expect(analysis.discover).not.toHaveBeenCalled()
  expect(service.handle({ method: 'analysis.status' })).toMatchObject({
    state: 'idle',
    error: null,
  })
  service.dispose()
})
it('surfaces oversized input without a provider call or an unbounded retry loop', async () => {
  vi.useFakeTimers()
  const { service, infer, analysis } = fixture()
  analysis.context = () => {
    throw Error('ANALYSIS_MESSAGE_TOO_LARGE')
  }
  service.start()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(service.handle({ method: 'analysis.status' })).toMatchObject({
    state: 'error',
    error: 'ANALYSIS_MESSAGE_TOO_LARGE',
  })
  expect(infer).not.toHaveBeenCalled()
  service.dispose()
})

it('rechecks source authorization before sending the review pass', async () => {
  vi.useFakeTimers()
  const { service, infer, analysis } = fixture()
  infer.mockImplementationOnce(async () => {
    analysis.context = () => {
      throw Error('ANALYSIS_SOURCE_UNAVAILABLE')
    }
    return { content: '{"tasks":[]}', model: 'fixture' }
  })
  service.start()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(infer).toHaveBeenCalledTimes(1)
  expect(analysis.discover).not.toHaveBeenCalled()
  expect(service.handle({ method: 'analysis.status' })).toMatchObject({
    state: 'error',
    error: 'ANALYSIS_SOURCE_UNAVAILABLE',
  })
  service.dispose()
})

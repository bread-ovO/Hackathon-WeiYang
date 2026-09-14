import { describe, expect, it, vi } from 'vitest'
import { cachePetParameterIndexes } from '../../apps/desktop/src/renderer/src/pet-parameter-cache'
import { createPetPixelReadback } from '../../apps/desktop/src/renderer/src/pet-pixel-readback'

describe('pet rendering efficiency', () => {
  it('resolves native IDs without scanning while preserving virtual parameters', () => {
    const ids = [{}, {}], virtual = {}
    const original = vi.fn(function(this: { count: number }, id: object) { return this.count + (id === virtual ? 0 : 1) })
    const model = { count: 2, getParameterCount: () => 2, getParameterId: (i: number) => ids[i]!, getParameterIndex: original }
    cachePetParameterIndexes(model)
    expect(model.getParameterIndex(ids[0]!)).toBe(0)
    expect(model.getParameterIndex(ids[1]!)).toBe(1)
    expect(original).not.toHaveBeenCalled()
    expect(model.getParameterIndex(virtual)).toBe(2)
    expect(original).toHaveBeenCalledOnce()
  })
  function mockGl() {
    return { PIXEL_PACK_BUFFER:1, STREAM_READ:2, RGBA:3, UNSIGNED_BYTE:4, SYNC_GPU_COMMANDS_COMPLETE:5, TIMEOUT_EXPIRED:6, WAIT_FAILED:7,
      createBuffer:vi.fn(() => ({})), bindBuffer:vi.fn(), bufferData:vi.fn(), readPixels:vi.fn(), fenceSync:vi.fn(() => ({})), flush:vi.fn(), clientWaitSync:vi.fn(() => 6), deleteSync:vi.fn(), getBufferSubData:vi.fn(), deleteBuffer:vi.fn() }
  }
  it('never blocks or queues extra reads while the GPU is busy', () => {
    const gl = mockGl(), reader = createPetPixelReadback(gl as unknown as WebGL2RenderingContext, 128)
    reader.enqueue(); reader.enqueue()
    expect(gl.readPixels).toHaveBeenCalledOnce()
    expect(reader.collect()).toBeNull()
    expect(gl.clientWaitSync).toHaveBeenCalledWith(expect.anything(), 0, 0)
    expect(gl.getBufferSubData).not.toHaveBeenCalled()
    gl.clientWaitSync.mockReturnValue(8)
    expect(reader.collect()).toHaveLength(128 * 128 * 4)
    expect(reader.pending).toBe(false)
    reader.enqueue(); reader.dispose(); reader.dispose()
    expect(gl.deleteBuffer).toHaveBeenCalledOnce()
    expect(gl.deleteSync).toHaveBeenCalledTimes(2)
    reader.enqueue()
    expect(gl.readPixels).toHaveBeenCalledTimes(2)
  })
  it('releases a failed fence without reading stale pixels', () => {
    const gl = mockGl(), reader = createPetPixelReadback(gl as unknown as WebGL2RenderingContext, 128)
    reader.enqueue(); gl.clientWaitSync.mockReturnValue(7)
    expect(() => reader.collect()).toThrow('PIXEL_READBACK_FAILED')
    expect(gl.getBufferSubData).not.toHaveBeenCalled()
    expect(reader.pending).toBe(false)
    reader.dispose()
  })
})

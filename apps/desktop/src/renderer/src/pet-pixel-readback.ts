/** One bounded GPU readback in flight. Never wait synchronously for the GPU. */
export function createPetPixelReadback(gl: WebGL2RenderingContext, size: number) {
  const buffer = gl.createBuffer()
  if (!buffer) throw new Error('PIXEL_BUFFER_UNAVAILABLE')
  const pixels = new Uint8Array(size * size * 4)
  let fence: WebGLSync | null = null
  let disposed = false
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
  gl.bufferData(gl.PIXEL_PACK_BUFFER, pixels.byteLength, gl.STREAM_READ)
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
  return {
    get pending() { return fence !== null },
    // Caller binds the reduced alpha framebuffer before enqueueing.
    enqueue() {
      if (disposed || fence) return
      try {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, 0)
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
        if (!fence) throw new Error('PIXEL_FENCE_UNAVAILABLE')
        gl.flush()
      } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null) }
    },
    collect(): Uint8Array | null {
      if (disposed || !fence) return null
      const status = gl.clientWaitSync(fence, 0, 0)
      if (status === gl.TIMEOUT_EXPIRED) return null
      gl.deleteSync(fence)
      fence = null
      if (status === gl.WAIT_FAILED) throw new Error('PIXEL_READBACK_FAILED')
      try {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer)
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, pixels)
        return pixels
      } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (fence) gl.deleteSync(fence)
      fence = null
      gl.deleteBuffer(buffer)
    },
  }
}

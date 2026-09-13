import { describe, it, expect } from 'vitest'
import { readBoundedUtf8 } from '../../packages/connectors/src/index'

describe('S08 streaming input boundaries', () => {
  it('decodes multibyte UTF-8 split at every byte and rejects malformed input', async () => {
    async function* bytes() {
      for (const value of new TextEncoder().encode('中文😀'))
        yield Uint8Array.of(value)
    }
    expect(
      await readBoundedUtf8(bytes(), 10, new AbortController().signal),
    ).toBe('中文😀')
    async function* invalid() {
      yield Uint8Array.of(0xe4, 0xb8)
    }
    await expect(
      readBoundedUtf8(invalid(), 10, new AbortController().signal),
    ).rejects.toThrow()
  })
  it('does not read from an already cancelled transport', async () => {
    let reads = 0
    async function* chunks() {
      reads++
      yield new Uint8Array(1)
    }
    const c = new AbortController()
    c.abort(new Error('TEST_ABORT'))
    await expect(readBoundedUtf8(chunks(), 10, c.signal)).rejects.toThrow(
      'TEST_ABORT',
    )
    expect(reads).toBe(0)
  })
  it('handles cancellation triggered while creating the iterator without reading', async () => {
    const c = new AbortController()
    let reads = 0
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        c.abort(new Error('TEST_ABORT'))
        return {
          next: async () => {
            reads++
            return { done: true, value: undefined }
          },
        }
      },
    }
    await expect(readBoundedUtf8(stream, 10, c.signal)).rejects.toThrow(
      'TEST_ABORT',
    )
    expect(reads).toBe(0)
  })
  it('cancels a stalled next chunk promptly and closes the iterator', async () => {
    const c = new AbortController()
    let closed = false,
      started!: () => void
    const began = new Promise<void>((resolve) => {
      started = resolve
    })
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            started()
            return new Promise(() => {})
          },
          return: async () => {
            closed = true
            return { done: true, value: undefined }
          },
        }
      },
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('READ_DID_NOT_CANCEL')), 250)
    })
    const reading = readBoundedUtf8(stream, 100, c.signal)
    const assertion = expect(Promise.race([reading, deadline])).rejects.toThrow(
      'TEST_ABORT',
    )
    await began
    c.abort(new Error('TEST_ABORT'))
    try {
      await assertion
      expect(closed).toBe(true)
    } finally {
      clearTimeout(timeout)
    }
  })
})

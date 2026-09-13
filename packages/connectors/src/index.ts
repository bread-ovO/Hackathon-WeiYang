export * from './feishu'
export * from './github'
export * from './http-client'

// Apply while receiving/decompressing transport chunks, before building the full payload.
export async function readBoundedUtf8(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('INVALID_BYTE_LIMIT')
  signal.throwIfAborted()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const iterator = chunks[Symbol.asyncIterator]()
  let total = 0,
    text = '',
    finished = false
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('ABORTED'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  // Cancellation can occur synchronously while creating/advancing an iterator.
  void aborted.catch(() => {})
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await Promise.race([iterator.next(), aborted])
      signal.throwIfAborted()
      if (next.done) {
        finished = true
        return text + decoder.decode()
      }
      total += next.value.byteLength
      if (total > maxBytes) throw new Error('PAGE_TOO_LARGE')
      text += decoder.decode(next.value, { stream: true })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    if (!finished) {
      // Request transport cleanup, but a stalled generator must not delay cancellation.
      // Real adapters must also pass this signal to their underlying network/file reader.
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {})
      } catch {
        /* Preserve the read/cancel error. */
      }
    }
  }
}

export {
  createGithubAccountFetcher,
  verifyGithubAccount,
} from './github-account'

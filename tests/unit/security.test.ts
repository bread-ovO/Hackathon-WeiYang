import { describe, expect, it, vi } from 'vitest'
import { createRequestHandler } from '../../apps/desktop/src/main/request-handler'
import { isTrustedPage } from '../../apps/desktop/src/main/security'

const url = 'memo://app/index.html'
function setup() {
  const frame = { url }
  const renderer = { mainFrame: frame, isDestroyed: () => false }
  const dispatch = vi.fn(async () => ({
    ok: false as const,
    error: 'CORE_UNAVAILABLE' as const,
  }))
  const handler = createRequestHandler(() => renderer, url, dispatch)
  return {
    frame,
    renderer,
    dispatch,
    handler,
    event: { sender: renderer, senderFrame: frame },
  }
}

describe('controlled IPC dispatch', () => {
  it('dispatches a valid request only from the live primary frame', async () => {
    const { handler, event, dispatch } = setup()
    expect(await handler(event, { method: 'health' })).toEqual({
      ok: false,
      error: 'CORE_UNAVAILABLE',
    })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ method: 'health' })
  })
  it('rejects a different window and same-URL child frame before dispatch', async () => {
    const { handler, event, dispatch } = setup()
    for (const untrusted of [
      { ...event, sender: {} },
      { ...event, senderFrame: { url } },
      { ...event, senderFrame: null },
    ])
      expect(await handler(untrusted, { method: 'health' })).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects navigation, destroyed renderers and detached frames', async () => {
    const { handler, event, frame, renderer, dispatch } = setup()
    frame.url = 'https://evil.invalid/'
    expect((await handler(event, { method: 'health' })).ok).toBe(false)
    frame.url = url
    renderer.isDestroyed = () => true
    expect((await handler(event, { method: 'health' })).ok).toBe(false)
    renderer.isDestroyed = () => false
    Object.defineProperty(event, 'senderFrame', {
      get: () => {
        throw new Error('detached')
      },
    })
    expect((await handler(event, { method: 'health' })).ok).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects a request when no window is registered', async () => {
    const { event, dispatch } = setup()
    expect(
      await createRequestHandler(
        () => null,
        url,
        dispatch,
      )(event, { method: 'health' }),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('rejects unknown methods, extra fields, extra arguments and oversized payloads', async () => {
    const { handler, event, dispatch } = setup()
    for (const args of [
      [],
      [null],
      [[]],
      [{}],
      [{ method: 'readFile' }],
      [{ method: 'health', path: '/private' }],
      [{ method: 'x'.repeat(65537) }],
      [{ method: 'health' }, 'extra'],
    ]) {
      expect(await handler(event, ...args)).toEqual({
        ok: false,
        error: 'INVALID_REQUEST',
      })
    }
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('does not leak internal exceptions to the renderer', async () => {
    const { event, renderer } = setup()
    const handler = createRequestHandler(
      () => renderer,
      url,
      async () => {
        throw new Error('/private/secret')
      },
    )
    expect(await handler(event, { method: 'health' })).toEqual({
      ok: false,
      error: 'INTERNAL_ERROR',
    })
  })
})

describe('entry URL policy', () => {
  it('allows hash navigation but rejects credentials and altered query, path or scheme', () => {
    expect(isTrustedPage(url + '#details', url)).toBe(true)
    for (const actual of [
      'memo://user:secret@app/index.html',
      url + '?unsafe=1',
      'memo://app/other.html',
      'https://app/index.html',
      'not a url',
    ])
      expect(isTrustedPage(actual, url)).toBe(false)
  })
})

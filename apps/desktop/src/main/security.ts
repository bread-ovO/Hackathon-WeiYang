/** Hash navigation is allowed; credentials, origins and entry paths must match. */
export function isTrustedPage(actual: string, expected: string): boolean {
  try {
    const a = new URL(actual)
    const b = new URL(expected)
    return (
      !a.username &&
      !a.password &&
      a.protocol === b.protocol &&
      a.host === b.host &&
      a.origin === b.origin &&
      a.pathname === b.pathname &&
      a.search === b.search
    )
  } catch {
    return false
  }
}

export interface RequestSender {
  sender: object
  senderFrame: { url: string } | null
}
export interface TrustedRenderer {
  mainFrame: { url: string }
  isDestroyed(): boolean
}

/** Object identity matters: another window loading the same URL is not trusted. */
export function isTrustedSender(
  event: RequestSender,
  renderer: TrustedRenderer | null,
  pageURL: string,
): boolean {
  try {
    return (
      renderer !== null &&
      !renderer.isDestroyed() &&
      event.sender === renderer &&
      event.senderFrame !== null &&
      event.senderFrame === renderer.mainFrame &&
      isTrustedPage(event.senderFrame.url, pageURL)
    )
  } catch {
    // A frame may have been detached while its request was queued.
    return false
  }
}

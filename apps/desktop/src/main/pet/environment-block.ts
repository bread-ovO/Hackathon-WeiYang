/** Turning the optional monitor off publishes unavailable as housekeeping,
 * not as a fresh failed probe. Power events remain authoritative while off. */
export function blocksPetPresentation(
  state: {
    locked: boolean
    suspended: boolean
    fullscreen: boolean
    available: boolean
  },
  monitoring: boolean,
): boolean {
  return (
    state.locked ||
    state.suspended ||
    (monitoring && (state.fullscreen || !state.available))
  )
}

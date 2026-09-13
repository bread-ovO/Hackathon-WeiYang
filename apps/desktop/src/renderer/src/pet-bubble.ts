export interface PetPresentation {
  reference?: { label: string; reason: string }
  id: string
  text?: string
  actionId?: string
  kind: 'action' | 'bubble'
}
interface PresentationDeps {
  show(
    text: string,
    close: () => void,
    context?: { id: string; label: string; reason: string },
  ): void
  hide(): void
  play(id: string): Promise<{ status: 'playing' | 'unavailable' }>
  currentAction(): { id: string | null; kind: 'idle' | 'motion' | 'expression' }
  ack(input: { id: string; status: 'done' | 'unavailable' }): Promise<void>
}
/** One host-owned queue item at a time; repeated polls never replay an action. */
export function createPetPresentationPlayer(deps: PresentationDeps) {
  let active: {
    item: PetPresentation
    bubbleDone: boolean
    actionDone: boolean
    starting: boolean
    unavailable: boolean
    acknowledging: boolean
  } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const completed = new Set<string>()
  function clear() {
    clearTimeout(timer)
    active = null
    deps.hide()
  }
  function finish() {
    const selected = active
    if (
      !selected ||
      selected.starting ||
      !selected.bubbleDone ||
      !selected.actionDone ||
      selected.acknowledging
    )
      return
    selected.acknowledging = true
    void deps
      .ack({
        id: selected.item.id,
        status: selected.unavailable ? 'unavailable' : 'done',
      })
      .then(() => {
        completed.add(selected.item.id)
        if (completed.size > 128)
          completed.delete(completed.values().next().value!)
        if (active === selected) clear()
      })
      .catch(() => {
        if (active === selected) selected.acknowledging = false
      })
  }
  function tick() {
    if (
      active &&
      !active.starting &&
      !active.actionDone &&
      deps.currentAction().kind === 'idle'
    )
      active.actionDone = true
    finish()
  }
  return {
    clear,
    tick,
    isBubbleOpen(id: string) {
      return (
        active?.item.id === id &&
        active.item.kind === 'bubble' &&
        !active.bubbleDone
      )
    },
    sync(item: PetPresentation | null) {
      if (!item) {
        clear()
        return
      }
      if (completed.has(item.id)) return
      if (active?.item.id === item.id) {
        tick()
        return
      }
      clear()
      const selected = (active = {
        item: { ...item },
        bubbleDone: item.kind !== 'bubble',
        actionDone: !item.actionId,
        starting: !!item.actionId,
        unavailable: item.kind === 'action' && !item.actionId,
        acknowledging: false,
      })
      if (item.kind === 'bubble') {
        const close = () => {
          if (active !== selected) return
          clearTimeout(timer)
          selected.bubbleDone = true
          deps.hide()
          finish()
        }
        // Callers must use textContent, never interpret message text as markup.
        deps.show(
          item.text ?? '',
          close,
          item.reference ? { id: item.id, ...item.reference } : undefined,
        )
        timer = setTimeout(close, 12000)
      }
      if (item.actionId) {
        void deps
          .play(item.actionId)
          .then((result) => {
            if (active !== selected) return
            selected.starting = false
            selected.actionDone = result.status !== 'playing'
            selected.unavailable =
              item.kind === 'action' && result.status === 'unavailable'
            tick()
          })
          .catch(() => {
            if (active !== selected) return
            selected.starting = false
            selected.actionDone = true
            selected.unavailable = item.kind === 'action'
            finish()
          })
      } else finish()
    },
  }
}

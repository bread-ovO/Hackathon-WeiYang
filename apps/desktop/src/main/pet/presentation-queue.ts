import { randomUUID } from 'node:crypto'
export interface PetPresentation {
  reference?: { label: string; reason: string }
  id: string
  kind: 'action' | 'bubble'
  text?: string
  actionId?: string
}
/** One active presentation, up to eight including waiting items; invalidation drops all work. */
export function createPresentationQueue() {
  let binding: string | null = null,
    items: PetPresentation[] = []
  return {
    bind(next: string | null) {
      if (next !== binding) {
        binding = next
        items = []
      }
    },
    clear() {
      items = []
      binding = null
    },
    current(): PetPresentation | null {
      return items[0] ? structuredClone(items[0]) : null
    },
    enqueue(
      expected: string,
      input: {
        kind: 'action' | 'bubble'
        text?: string
        actionId?: string
        reference?: { label: string; reason: string }
      },
      allowed: ReadonlySet<string>,
    ): boolean {
      if (binding !== expected || !binding || items.length >= 8) return false
      if (input.kind !== 'action' && input.kind !== 'bubble') return false
      if (
        input.actionId !== undefined &&
        (typeof input.actionId !== 'string' || !allowed.has(input.actionId))
      )
        return false
      if (
        input.kind === 'action' &&
        (input.actionId === undefined || input.text !== undefined)
      )
        return false
      if (
        input.kind === 'bubble' &&
        (typeof input.text !== 'string' ||
          Array.from(input.text).length < 1 ||
          Array.from(input.text).length > 240 ||
          !input.text.trim() ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(
            input.text,
          ))
      )
        return false
      if (
        input.reference !== undefined &&
        (input.kind !== 'bubble' ||
          !input.reference ||
          typeof input.reference !== 'object' ||
          Array.isArray(input.reference) ||
          Object.keys(input.reference).sort().join(',') !== 'label,reason' ||
          [input.reference.label, input.reference.reason].some(
            (x) =>
              typeof x !== 'string' ||
              !x.trim() ||
              x.length > 240 ||
              /[\u0000-\u001f\u007f]/u.test(x),
          ))
      )
        return false
      items.push({
        ...(input.reference ? { reference: { ...input.reference } } : {}),
        id: randomUUID(),
        kind: input.kind,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.actionId !== undefined ? { actionId: input.actionId } : {}),
      })
      return true
    },
    ack(expected: string, id: string) {
      if (binding !== expected || items[0]?.id !== id) return false
      items.shift()
      return true
    },
    cancel(id: string) {
      items = items.filter((item) => item.id !== id)
    },
    dismissBubble() {
      if (items[0]?.kind === 'bubble') items.shift()
    },
  }
}

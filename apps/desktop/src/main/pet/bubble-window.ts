export interface BubbleWindowLike {
  isVisible(): boolean
  isDestroyed(): boolean
  show(): void
  hide(): void
  destroy(): void
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void
  getBounds(): { x: number; y: number; width: number; height: number }
  webContents: { send(channel: string, payload: unknown): void }
}
export interface BubblePlatform {
  createWindow(): BubbleWindowLike
  usableArea(): { x: number; y: number; width: number; height: number }
  /** Anchor the bubble above the pet window. */
  petBounds(): { x: number; y: number; width: number; height: number } | null
}
export interface BubbleBounds {
  width: number
  height: number
}
export const bubbleSize = { width: 280, height: 150 } as const

/** PET09: keeps the bubble on screen next to the pet. */
export function placeBubble(
  pet: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  const centeredX = pet.x + (pet.width - bubbleSize.width) / 2
  const aboveY = pet.y - bubbleSize.height - 12
  const belowY = pet.y + pet.height + 12
  const fitsAbove = aboveY >= area.y
  return {
    x: Math.round(
      Math.min(
        Math.max(centeredX, area.x),
        area.x + area.width - bubbleSize.width,
      ),
    ),
    y: Math.round(fitsAbove ? Math.max(aboveY, area.y) : Math.min(belowY, area.y + area.height - bubbleSize.height)),
  }
}

/** One bubble at a time; extra messages queue without stacking. */
export function createBubbleController(platform: BubblePlatform) {
  let window: BubbleWindowLike | null = null
  const queue: string[] = []
  let visibleText: string | null = null
  const ensureWindow = () => {
    if (window && !window.isDestroyed()) return
    window = platform.createWindow()
  }
  const present = (text: string) => {
    ensureWindow()
    const pet = platform.petBounds()
    if (pet) {
      const { x, y } = placeBubble(pet, platform.usableArea())
      window!.setBounds({ x, y, width: bubbleSize.width, height: bubbleSize.height })
    }
    visibleText = text
    window!.webContents.send('bubble:show', { text })
    window!.show()
  }
  const pump = () => {
    if (visibleText !== null || queue.length === 0) return
    present(queue.shift()!)
  }
  return {
    /** Queue a message; duplicates of the visible one are dropped. */
    speak(text: string): void {
      if (!text.trim() || text === visibleText) return
      queue.push(text)
      pump()
    },
    /** Re-send the visible text (renderer finished loading after the race). */
    replay(): void {
      if (visibleText !== null && window && !window.isDestroyed())
        window.webContents.send('bubble:show', { text: visibleText })
    },
    /** Called by the renderer close button; advances the queue. */
    dismiss(): void {
      if (visibleText === null) return
      visibleText = null
      if (window && !window.isDestroyed()) window.hide()
      pump()
    },
    displaying(): string | null {
      return visibleText
    },
    pending(): number {
      return queue.length
    },
    dispose(): void {
      queue.length = 0
      visibleText = null
      if (window && !window.isDestroyed()) window.destroy()
      window = null
    },
  }
}

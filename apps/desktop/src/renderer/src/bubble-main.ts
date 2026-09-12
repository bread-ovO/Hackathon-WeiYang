const bridge = (window as unknown as {
  bubble?: {
    onShow: (handler: (text: string) => void) => void
    ready: () => void
    close: () => void
  }
}).bubble
const text = document.getElementById('text') as HTMLDivElement
bridge?.onShow((value) => {
  // Long text wraps inside the scrollable area (PET09 acceptance).
  text.textContent = value
})
document.getElementById('close')?.addEventListener('click', () => {
  text.textContent = ''
  bridge?.close()
})
bridge?.ready()

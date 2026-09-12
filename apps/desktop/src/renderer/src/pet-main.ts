// PET05 placeholder mascot surface. This is window-machinery verification,
// NOT Live2D rendering — PET06 replaces the canvas content with the Cubism
// pipeline while keeping this input contract (hover hit-test, wheel zoom).
const canvas = document.getElementById('stage') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const input = (window as unknown as {
  petInput?: {
    hover: (hit: boolean) => void
    zoom: (delta: number) => void
  }
}).petInput

const resize = () => {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio)
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio)
}
window.addEventListener('resize', resize)

let frame = 0
const draw = () => {
  resize()
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  const breathe = 1 + Math.sin(frame / 40) * 0.02
  const r = Math.min(width, height) * 0.34 * breathe
  const cx = width / 2
  const cy = height * 0.58
  const gradient = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.2, cx, cy, r * 1.2)
  gradient.addColorStop(0, '#f2926d')
  gradient.addColorStop(1, '#e15a24')
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  // Face keeps the blob recognizable as a placeholder companion.
  ctx.fillStyle = '#3b2417'
  const eye = r * 0.09
  const blink = Math.sin(frame / 26) > 0.96 ? eye * 0.15 : eye
  for (const side of [-1, 1]) {
    ctx.beginPath()
    ctx.ellipse(cx + side * r * 0.34, cy - r * 0.18, eye, blink, 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.strokeStyle = '#3b2417'
  ctx.lineWidth = Math.max(2, r * 0.045)
  ctx.beginPath()
  ctx.arc(cx, cy + r * 0.12, r * 0.22, 0.15 * Math.PI, 0.85 * Math.PI)
  ctx.stroke()
  frame++
  requestAnimationFrame(draw)
}
draw()

const alphaAt = (x: number, y: number) => {
  const data = ctx.getImageData(
    Math.round(x * devicePixelRatio),
    Math.round(y * devicePixelRatio),
    1,
    1,
  ).data
  return data[3]! > 8
}
let hovering = true
document.addEventListener('mousemove', event => {
  // Forwarded events keep arriving even while the window ignores the mouse.
  const hit = alphaAt(event.clientX, event.clientY)
  if (hit !== hovering) {
    hovering = hit
    input?.hover(hit)
  }
})
document.addEventListener(
  'wheel',
  event => {
    input?.zoom(event.deltaY > 0 ? -0.1 : 0.1)
  },
  { passive: true },
)

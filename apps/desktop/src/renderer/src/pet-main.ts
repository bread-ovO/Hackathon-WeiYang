// PET05 placeholder surface + PET06 Live2D pipeline. Diagnostics land on
// window.__petRender so e2e can assert the honest mode (never fake success).
import { bootLive2D, type Live2DSession, type RuntimeModel } from './pet-live2d'

const canvas2d = document.getElementById('stage-2d') as HTMLCanvasElement
const canvasGL = document.getElementById('stage-gl') as HTMLCanvasElement
const ctx = canvas2d.getContext('2d')!
const input = (window as unknown as {
  petInput?: {
    hover: (hit: boolean) => void
    zoom: (delta: number) => void
    model?: () => Promise<RuntimeModel | null>
  }
}).petInput

const diagnostics = (window.__petRender = {
  mode: 'booting' as 'booting' | 'live2d' | 'breathing-only' | 'placeholder',
  error: null as string | null,
  frames: 0,
  idle: false,
  hidden: false,
  contextLost: 0,
} as {
  mode: 'booting' | 'live2d' | 'breathing-only' | 'placeholder'
  error: string | null
  frames: number
  idle: boolean
  hidden: boolean
  contextLost: number
})
declare global {
  interface Window {
    __petRender?: {
      mode: 'booting' | 'live2d' | 'breathing-only' | 'placeholder'
      error: string | null
      frames: number
      idle: boolean
      hidden: boolean
      contextLost: number
    }
  }
}
// One canvas per context kind; exactly one is displayed at a time.
const showCanvas = (which: '2d' | 'gl') => {
  canvas2d.style.display = which === '2d' ? 'block' : 'none'
  canvasGL.style.display = which === 'gl' ? 'block' : 'none'
}
const resize = (canvas: HTMLCanvasElement) => {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio)
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio)
}
window.addEventListener('resize', () => {
  resize(canvas2d)
  if (session) resize(canvasGL)
})

let session: Live2DSession | null = null
let placeholderFrame = 0
const drawPlaceholder = () => {
  resize(canvas2d)
  const { width, height } = canvas2d
  ctx.clearRect(0, 0, width, height)
  const breathe = 1 + Math.sin(placeholderFrame / 40) * 0.02
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
  ctx.fillStyle = '#3b2417'
  const eye = r * 0.09
  const blink = Math.sin(placeholderFrame / 26) > 0.96 ? eye * 0.15 : eye
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
  placeholderFrame++
}

const boot = async () => {
  const model = input?.model ? await input.model() : null
  if (!model) {
    diagnostics.mode = 'placeholder'
    showCanvas('2d')
    return
  }
  try {
    resize(canvasGL)
    session = await bootLive2D(canvasGL, model)
    diagnostics.mode = session.mode
    showCanvas('gl')
  } catch (error) {
    // Honest degradation: an unrenderable model keeps the placeholder.
    session = null
    diagnostics.mode = 'placeholder'
    diagnostics.error = error instanceof Error ? error.message : String(error)
    showCanvas('2d')
  }
}
void boot()

// PET14: full cadence while interacting, ~15fps when idle, zero when hidden.
const fullFrameMs = 1000 / 30
const idleFrameMs = 1000 / 15
const idleAfterMs = 5000
let lastInteraction = performance.now()
let lastFrameAt = 0
let renderQueued = false
for (const type of ['mousemove', 'wheel', 'pointerdown'] as const)
  document.addEventListener(type, () => {
    lastInteraction = performance.now()
  })
const render = (now: number) => {
  renderQueued = false
  if (document.hidden) {
    // Hidden windows stop rendering entirely; rAF is paused by the platform,
    // the explicit check keeps the contract observable in diagnostics.
    diagnostics.hidden = true
    return
  }
  diagnostics.hidden = false
  const idle = now - lastInteraction > idleAfterMs
  const budget = idle ? idleFrameMs : fullFrameMs
  if (now - lastFrameAt < budget) {
    queueRender()
    return
  }
  lastFrameAt = now
  if (session) session.frame(now)
  else drawPlaceholder()
  diagnostics.frames++
  diagnostics.idle = idle
  queueRender()
}
const queueRender = () => {
  if (!renderQueued) {
    renderQueued = true
    requestAnimationFrame(render)
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) queueRender()
})
queueRender()
// PET14: a lost WebGL context must recover, not freeze the pet.
canvasGL.addEventListener('webglcontextlost', (event) => {
  event.preventDefault()
  session?.dispose()
  session = null
  diagnostics.mode = 'booting'
  diagnostics.contextLost = (diagnostics.contextLost ?? 0) + 1
  void boot()
})

// PET06: a changed current model must release GPU state and reboot; a
// lightweight poll keeps this renderer-side without extra push IPC.
let lastModelId: string | null = null
const syncModel = async () => {
  if (!input?.model) return
  try {
    const model = await input.model()
    const id = model ? model.id : null
    if (id !== lastModelId) {
      lastModelId = id
      session?.dispose()
      session = null
      diagnostics.mode = 'booting'
      diagnostics.error = null
      await boot()
    }
  } catch {
    /* transient worker hiccup keeps the current session */
  }
}
setInterval(() => void syncModel(), 5000)

const alpha2dAt = (x: number, y: number) => {
  const data = ctx.getImageData(
    Math.round(x * devicePixelRatio),
    Math.round(y * devicePixelRatio),
    1,
    1,
  ).data
  return data[3]! > 8
}
const alphaAt = (x: number, y: number) =>
  session ? session.alphaAt(x, y) > 8 : alpha2dAt(x, y)
let hovering = true
document.addEventListener('mousemove', (event) => {
  // Forwarded events keep arriving even while the window ignores the mouse.
  const hit = alphaAt(event.clientX, event.clientY)
  if (hit !== hovering) {
    hovering = hit
    input?.hover(hit)
  }
})
document.addEventListener(
  'wheel',
  (event) => {
    input?.zoom(event.deltaY > 0 ? -0.1 : 0.1)
  },
  { passive: true },
)

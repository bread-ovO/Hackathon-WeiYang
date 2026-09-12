import { createPetPresentationPlayer, type PetPresentation } from './pet-bubble'
import {
  bootLive2D,
  PetRenderError,
  type Live2DSession,
  type PetRenderErrorCode,
  type RuntimeModel,
} from './pet-live2d'
interface PetInput {
  state(): Promise<{
    model: RuntimeModel | null
    visible: boolean
    presentation: PetPresentation | null
    preferences: { scale: number; alwaysOnTop: boolean; clickThrough: boolean }
  }>
  ack(input: { id: string; status: 'done' | 'unavailable' }): Promise<void>
  hitTest(input: { interactive: boolean }): Promise<void>
  drag(input: { phase: 'start' | 'move' | 'end' }): Promise<void>
  report(input: {
    modelId: string
    status: 'ready' | 'error'
    code?: PetRenderErrorCode
  }): Promise<void> | void
}
declare global {
  interface Window {
    petInput?: PetInput
    __petRender?: {
      mode: 'empty' | 'loading' | 'live2d' | 'live2d-idle' | 'error'
      error: PetRenderErrorCode | null
      frames: number
      modelId: string | null
      currentAction: {
        id: string | null
        kind: 'idle' | 'motion' | 'expression'
      }
    }
  }
}
const canvas = document.getElementById('stage-gl') as HTMLCanvasElement
const message = document.getElementById('pet-status') as HTMLDivElement
const bubble = document.getElementById('pet-bubble') as HTMLDivElement
const bubbleText = document.getElementById('pet-bubble-text') as HTMLDivElement
const bubbleClose = document.getElementById(
  'pet-bubble-close',
) as HTMLButtonElement
let closeBubble: (() => void) | undefined
const input = window.petInput
const diagnostics = (window.__petRender = {
  mode: 'empty' as 'empty' | 'loading' | 'live2d' | 'live2d-idle' | 'error',
  error: null as PetRenderErrorCode | null,
  frames: 0,
  modelId: null as string | null,
  currentAction: {
    id: null as string | null,
    kind: 'idle' as 'idle' | 'motion' | 'expression',
  },
})
const errors: Record<PetRenderErrorCode, string> = {
  RUNTIME_MISSING: 'Live2D 运行环境尚未就绪',
  MODEL_LOAD_FAILED: '无法读取所选模型',
  MOC3_INVALID: '模型不兼容当前 Live2D 版本',
  WEBGL_UNAVAILABLE: '当前设备无法启动 WebGL2',
  TEXTURE_INVALID: '模型纹理无法加载',
  MOTION_INVALID: '模型待机动作无法播放',
  PHYSICS_INVALID: '模型物理配置无法加载',
  SHADER_TIMEOUT: '模型着色器未能完成加载',
  RENDER_FAILED: '模型渲染已停止，请重新选择模型',
}
let session: Live2DSession | null = null,
  controller: AbortController | undefined,
  key: string | null = null,
  visible = false,
  stopped = false,
  polling = false
let bootChain: Promise<void> = Promise.resolve(),
  generation = 0,
  lastFrame = 0,
  animation = 0
let clickThrough = true,
  dragging = false,
  activePointer: number | null = null
let pointer: { x: number; y: number } | null = null,
  lastInteractive: boolean | undefined
let lastDragMove = -Infinity
function sendHit(interactive: boolean) {
  if (!input || lastInteractive === interactive) return
  lastInteractive = interactive
  void input.hitTest({ interactive }).catch(() => {
    lastInteractive = undefined
  })
}
function modelHit() {
  if (!pointer || !session || canvas.hidden) return false
  const rect = canvas.getBoundingClientRect()
  return session.hitTest(
    pointer.x - rect.left,
    pointer.y - rect.top,
    rect.width,
    rect.height,
  )
}
function bubbleHit() {
  if (!pointer || bubble.hidden) return false
  const r = bubble.getBoundingClientRect()
  return (
    pointer.x >= r.left &&
    pointer.x < r.right &&
    pointer.y >= r.top &&
    pointer.y < r.bottom
  )
}
function refreshHit() {
  const rect = message.getBoundingClientRect()
  const statusHit =
    !!pointer &&
    !message.hidden &&
    pointer.x >= rect.left &&
    pointer.x < rect.right &&
    pointer.y >= rect.top &&
    pointer.y < rect.bottom
  const interactive =
    dragging ||
    (!document.hidden &&
      visible &&
      (!clickThrough || statusHit || bubbleHit() || modelHit()))
  canvas.style.cursor = dragging ? 'grabbing' : modelHit() ? 'grab' : 'default'
  sendHit(interactive)
}
function endDrag() {
  if (!dragging) return
  dragging = false
  if (activePointer !== null) {
    try {
      canvas.releasePointerCapture(activePointer)
    } catch {
      /* pointer already released */
    }
  }
  activePointer = null
  if (input) void input.drag({ phase: 'end' }).catch(() => {})
  refreshHit()
}
function trackPointer(event: MouseEvent) {
  pointer = { x: event.clientX, y: event.clientY }
  if (dragging && input) {
    if (event.buttons === 0) {
      endDrag()
      return
    }
    const now = performance.now()
    if (now - lastDragMove >= 1000 / 30) {
      lastDragMove = now
      void input.drag({ phase: 'move' }).catch(endDrag)
    }
  }
  refreshHit()
}
// Electron forwards mousemove while ignoring mouse events; pointermove alone
// cannot reliably restore interaction when the cursor enters opaque pixels.
// pointerdown.preventDefault suppresses compatibility mousemove during drag.
// Keep both: pointermove drives captured drags, mousemove restores forwarded hits.
window.addEventListener('pointermove', trackPointer)
window.addEventListener('mousemove', trackPointer)
canvas.addEventListener('pointerdown', (event) => {
  pointer = { x: event.clientX, y: event.clientY }
  if (
    event.button !== 0 ||
    !visible ||
    bubbleHit() ||
    !modelHit() ||
    !input ||
    dragging
  )
    return
  event.preventDefault()
  dragging = true
  activePointer = event.pointerId
  try {
    canvas.setPointerCapture(event.pointerId)
  } catch {
    /* main also ends on lost button */
  }
  refreshHit()
  void input.drag({ phase: 'start' }).catch(endDrag)
})
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)
canvas.addEventListener('lostpointercapture', endDrag)
window.addEventListener('blur', () => {
  pointer = null
  endDrag()
  refreshHit()
})
window.addEventListener('mouseout', (event) => {
  if (event.relatedTarget === null && !dragging) {
    pointer = null
    refreshHit()
  }
})
const show = (text: string) => {
  message.textContent = text
  message.hidden = !text
  refreshHit()
}
const report = (
  modelId: string,
  status: 'ready' | 'error',
  code?: PetRenderErrorCode,
) => {
  if (!input) return
  void Promise.resolve()
    .then(() => input.report({ modelId, status, ...(code ? { code } : {}) }))
    .catch(() => {
      /* host may have changed the selected model */
    })
}
const presentation = createPetPresentationPlayer({
  show(text, close) {
    bubbleText.textContent = text
    closeBubble = close
    bubble.hidden = false
    refreshHit()
  },
  hide() {
    bubble.hidden = true
    bubbleText.textContent = ''
    closeBubble = undefined
    refreshHit()
  },
  play: async (id) => (session ? session.play(id) : { status: 'unavailable' }),
  currentAction: () => session?.currentAction() ?? { id: null, kind: 'idle' },
  ack: async (request) => {
    await input?.ack(request)
  },
})
bubbleClose.addEventListener('click', () => closeBubble?.())
bubble.addEventListener('pointerdown', (event) => {
  event.stopPropagation()
})
function clear() {
  presentation.clear()
  endDrag()
  pointer = null
  controller?.abort()
  controller = undefined
  session?.dispose()
  session = null
  canvas.hidden = true
  show('')
  diagnostics.mode = 'empty'
  diagnostics.error = null
  diagnostics.frames = 0
  diagnostics.modelId = null
  diagnostics.currentAction = { id: null, kind: 'idle' }
}
function select(model: RuntimeModel | null) {
  const selected = model ? { id: model.id, entry: model.entry } : null
  const next = selected ? `${selected.id}/${selected.entry}` : null
  if (next === key) return
  key = next
  const ticket = ++generation
  clear()
  if (!selected) return
  diagnostics.mode = 'loading'
  diagnostics.modelId = selected.id
  show('正在加载模型…')
  const abort = new AbortController()
  controller = abort
  // Serialize global Cubism cleanup before new initialization; polling remains
  // independent so a model change can abort an in-flight resource load.
  bootChain = bootChain
    .catch(() => undefined)
    .then(async () => {
      if (stopped || ticket !== generation || abort.signal.aborted) return
      try {
        canvas.hidden = false
        const created = await bootLive2D(canvas, selected, abort.signal)
        if (stopped || ticket !== generation || abort.signal.aborted) {
          created.dispose()
          return
        }
        session = created
        diagnostics.mode = created.mode
        diagnostics.error = null
        show('')
        report(selected.id, 'ready')
      } catch (error) {
        if (stopped || ticket !== generation || abort.signal.aborted) return
        const code =
          error instanceof PetRenderError ? error.code : 'RENDER_FAILED'
        diagnostics.mode = 'error'
        diagnostics.error = code
        canvas.hidden = true
        show(errors[code])
        report(selected.id, 'error', code)
      }
    })
}
async function poll() {
  if (stopped || polling || !input) return
  polling = true
  try {
    const result = await input.state()
    if (stopped) return
    if (
      !result ||
      typeof result.visible !== 'boolean' ||
      (result.model !== null &&
        (!result.model ||
          typeof result.model.id !== 'string' ||
          typeof result.model.entry !== 'string'))
    )
      throw new Error('bad state')
    if (typeof result.preferences?.clickThrough !== 'boolean')
      throw new Error('bad preferences')
    clickThrough = result.preferences.clickThrough
    visible = result.visible
    if (!visible) endDrag()
    refreshHit()
    if (!visible) session?.pause()
    select(result.model)
    if (session && visible) presentation.sync(result.presentation ?? null)
    else if (!visible) presentation.clear()
  } catch {
    if (stopped) return
    visible = false
    generation++
    key = null
    clear()
    show('暂时无法读取桌宠状态')
  } finally {
    polling = false
  }
}
function render(now: number) {
  if (stopped) return
  if (visible && !document.hidden && session && now - lastFrame >= 1000 / 30) {
    lastFrame = now
    try {
      session.frame(now)
      diagnostics.frames++
      diagnostics.currentAction = session.currentAction()
      presentation.tick()
    } catch (error) {
      session.dispose()
      session = null
      const code =
        error instanceof PetRenderError ? error.code : 'RENDER_FAILED'
      diagnostics.mode = 'error'
      diagnostics.error = code
      canvas.hidden = true
      show(errors[code])
      if (diagnostics.modelId) report(diagnostics.modelId, 'error', code)
    }
  } else if (!visible || document.hidden) session?.pause()
  refreshHit()
  animation = requestAnimationFrame(render)
}
const resize = () => {
  try {
    session?.resize()
  } catch {
    session?.dispose()
    session = null
    diagnostics.mode = 'error'
    diagnostics.error = 'RENDER_FAILED'
    canvas.hidden = true
    show(errors.RENDER_FAILED)
    if (diagnostics.modelId)
      report(diagnostics.modelId, 'error', 'RENDER_FAILED')
  }
}
window.addEventListener('resize', resize)
document.addEventListener('visibilitychange', () => {
  session?.pause()
  if (document.hidden) {
    pointer = null
    endDrag()
    refreshHit()
  }
  if (!document.hidden) void poll()
})
const timer = setInterval(() => void poll(), 1000)
window.addEventListener(
  'pagehide',
  () => {
    stopped = true
    generation++
    clearInterval(timer)
    cancelAnimationFrame(animation)
    window.removeEventListener('resize', resize)
    clear()
  },
  { once: true },
)
if (!input) {
  diagnostics.mode = 'error'
  diagnostics.error = 'RUNTIME_MISSING'
  show('桌宠窗口连接未就绪')
} else {
  void poll()
  animation = requestAnimationFrame(render)
}

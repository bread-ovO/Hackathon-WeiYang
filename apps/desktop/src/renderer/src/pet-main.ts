import {
  createPetFrameBudget,
  createPetRecoveryBudget,
  petTargetFps,
} from './pet-frame-budget'
import { createPetAudioPlayer } from './pet-audio'
import type { PetVoiceAudio, PetVoicePlayback } from '@memo/contracts'
import { createPetPresentationPlayer, type PetPresentation } from './pet-bubble'
import {
  bootLive2D,
  PetRenderError,
  type Live2DSession,
  type PetRenderErrorCode,
  type RuntimeModel,
} from './pet-live2d'
interface PetInput {
  voiceAudio(input: {
    id: string
    version: number
  }): Promise<PetVoiceAudio | null>
  voiceReport(input: {
    id: string
    version: number
    status: 'playing' | 'ended' | 'error'
  }): Promise<void>
  onVoiceStop(callback: () => void): () => void
  openContext(input: { id: string }): Promise<boolean>
  state(): Promise<{
    model: RuntimeModel | null
    visible: boolean
    presentation: PetPresentation | null
    voice?: PetVoicePlayback
    preferences: { scale: number; alwaysOnTop: boolean; clickThrough: boolean; performanceMode?: 'balanced' | 'smooth' }
  }>
  ack(input: { id: string; status: 'done' | 'unavailable' }): Promise<void>
  hitTest(input: { interactive: boolean }): Promise<void>
  drag(input: { phase: 'start' | 'move' | 'end' }): Promise<void>
  report(input: {
    modelId: string
    status: 'ready' | 'error' | 'recovering'
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
      totalFrames: number
      targetFps: 30 | 60
      recoveries: number
      contextState: 'ready' | 'lost' | 'recovering' | 'failed'
      modelId: string | null
      audioPlaying: boolean
      lipSyncAvailable: boolean
      lipSyncLevel: number | null
      lipSyncAppliedFrames: number
      lipSyncParameters: { index: number; value: number }[]
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
const voiceStop = document.getElementById('pet-voice-stop') as HTMLButtonElement
const contextButton = document.createElement('button')
contextButton.type = 'button'
contextButton.hidden = true
contextButton.id = 'pet-context-link'
bubbleText.after(contextButton)
let contextId: string | null = null
contextButton.addEventListener('click', async () => {
  const id = contextId
  if (!id || !input) return
  contextButton.disabled = true
  try {
    const opened = await input.openContext({ id })
    if (contextId === id && !opened)
      contextButton.textContent = '依据已变化，请在主窗口复核'
  } catch {
    if (contextId === id) contextButton.textContent = '暂不能打开事项'
  } finally {
    if (contextId === id) contextButton.disabled = false
  }
})
const bubbleClose = document.getElementById(
  'pet-bubble-close',
) as HTMLButtonElement
let closeBubble: (() => void) | undefined
const input = window.petInput
const diagnostics = (window.__petRender = {
  mode: 'empty' as 'empty' | 'loading' | 'live2d' | 'live2d-idle' | 'error',
  error: null as PetRenderErrorCode | null,
  frames: 0,
  totalFrames: 0,
  targetFps: 30 as 30 | 60,
  recoveries: 0,
  contextState: 'ready' as 'ready' | 'lost' | 'recovering' | 'failed',
  modelId: null as string | null,
  audioPlaying: false as boolean,
  lipSyncAvailable: false as boolean,
  lipSyncLevel: null as number | null,
  lipSyncAppliedFrames: 0,
  lipSyncParameters: [] as { index: number; value: number }[],
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
  animation = 0
let clickThrough = true,
  dragging = false,
  activePointer: number | null = null
let pointer: { x: number; y: number } | null = null,
  lastInteractive: boolean | undefined
const frameBudget = createPetFrameBudget(),
  recoveryBudget = createPetRecoveryBudget()
let lastInteraction = -Infinity
let selectedModel: RuntimeModel | null = null
let voiceSnapshot: PetVoicePlayback | undefined
const audio = createPetAudioPlayer({
  audio: (request) => input?.voiceAudio(request) ?? Promise.resolve(null),
  report: (request) => input?.voiceReport(request) ?? Promise.resolve(),
  lip(level) {
    diagnostics.lipSyncLevel = level
    session?.setLipSyncLevel(level)
  },
  changed(playing) {
    diagnostics.audioPlaying = playing
    voiceStop.hidden = !playing
  },
})
let voiceEpoch = 0
const unsubscribeVoiceStop = input?.onVoiceStop(() => {
  voiceEpoch++
  audio.stop()
})
voiceStop.addEventListener('click', () => audio.stop())
function stopAudio() {
  audio.stop()
  if (voiceSnapshot?.id && voiceSnapshot.status === 'synthesizing') {
    const { id, version } = voiceSnapshot
    void input?.voiceReport({ id, version, status: 'ended' }).catch(() => {})
  }
  voiceSnapshot = undefined
}
let recovery: {
  ticket: number
  model: RuntimeModel
  timer: ReturnType<typeof setTimeout>
} | null = null
function stopFrames() {
  cancelAnimationFrame(animation)
  animation = 0
  frameBudget.reset()
  session?.pause()
}
function wakeFrames() {
  if (
    !animation &&
    !stopped &&
    visible &&
    !document.hidden &&
    session &&
    !recovery
  )
    animation = requestAnimationFrame(render)
}
function interacted() {
  lastInteraction = performance.now()
  wakeFrames()
}
function cancelRecovery() {
  if (recovery) clearTimeout(recovery.timer)
  recovery = null
}
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
let performanceMode: 'balanced' | 'smooth' = 'balanced'
function refreshHit() {
  const rect = pointer && !message.hidden ? message.getBoundingClientRect() : null
  const statusHit =
    !!pointer &&
    !!rect &&
    pointer.x >= rect.left &&
    pointer.x < rect.right &&
    pointer.y >= rect.top &&
    pointer.y < rect.bottom
  const overModel = modelHit()
  const interactive =
    dragging ||
    (!document.hidden &&
      visible &&
      (!clickThrough || statusHit || bubbleHit() || overModel))
  const cursor = dragging ? 'grabbing' : overModel ? 'grab' : 'default'
  if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor
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
  interacted()
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
window.addEventListener('pointerdown', interacted)
window.addEventListener('keydown', interacted)
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
  status: 'ready' | 'error' | 'recovering',
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
  show(text, close, context) {
    contextId = context?.id ?? null
    contextButton.hidden = !context
    contextButton.disabled = false
    contextButton.textContent = context?.label ?? ''
    contextButton.title = context?.reason ?? ''

    bubbleText.textContent = text
    closeBubble = close
    bubble.hidden = false
    refreshHit()
  },
  hide() {
    stopAudio()
    contextId = null
    contextButton.hidden = true
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
  cancelRecovery()
  stopFrames()
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
  diagnostics.lipSyncAvailable = false
  diagnostics.lipSyncAppliedFrames = 0
  diagnostics.lipSyncParameters = []
  diagnostics.contextState = 'ready'
}
function select(model: RuntimeModel | null, restoring = false) {
  const selected = model ? { id: model.id, entry: model.entry } : null
  const next = selected ? `${selected.id}/${selected.entry}` : null
  if (next === key && !restoring) return
  key = next
  selectedModel = selected
  const ticket = ++generation
  const pendingRecovery = restoring ? recovery : null
  if (restoring) recovery = null
  clear()
  if (pendingRecovery) {
    recovery = pendingRecovery
    pendingRecovery.ticket = ticket
    diagnostics.contextState = 'recovering'
  }
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
        diagnostics.lipSyncAvailable = created.lipSyncAvailable
        diagnostics.mode = created.mode
        diagnostics.error = null
        show('')
        if (recovery?.ticket === ticket) cancelRecovery()
        diagnostics.contextState = 'ready'
        report(selected.id, 'ready')
        frameBudget.reset()
        wakeFrames()
      } catch (error) {
        if (stopped || ticket !== generation || abort.signal.aborted) return
        const code =
          error instanceof PetRenderError ? error.code : 'RENDER_FAILED'
        cancelRecovery()
        diagnostics.contextState = 'failed'
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
  const voiceTicket = voiceEpoch
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
    performanceMode = result.preferences.performanceMode === 'smooth' ? 'smooth' : 'balanced'
    clickThrough = result.preferences.clickThrough
    visible = result.visible
    if (!visible) endDrag()
    refreshHit()
    if (!visible || document.hidden) stopFrames()
    select(result.model)
    if (session && visible && !document.hidden) {
      presentation.sync(result.presentation ?? null)
      voiceSnapshot = result.voice
      if (voiceTicket === voiceEpoch)
        audio.sync(
          result.voice,
          result.presentation &&
            presentation.isBubbleOpen(result.presentation.id)
            ? result.presentation.id
            : null,
        )
    } else if (!visible) presentation.clear()
    wakeFrames()
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
function failContext(modelId: string) {
  generation++
  clear()
  diagnostics.modelId = modelId
  diagnostics.contextState = 'failed'
  diagnostics.mode = 'error'
  diagnostics.error = 'WEBGL_UNAVAILABLE'
  show(errors.WEBGL_UNAVAILABLE)
  report(modelId, 'error', 'WEBGL_UNAVAILABLE')
}
function contextLost(event: Event) {
  event.preventDefault()
  if (stopped || !selectedModel || recovery) return
  const model = { ...selectedModel }
  if (!recoveryBudget.take(performance.now())) {
    failContext(model.id)
    return
  }
  generation++
  clear()
  diagnostics.recoveries++
  diagnostics.modelId = model.id
  diagnostics.mode = 'loading'
  diagnostics.contextState = 'lost'
  const attempt = {
    ticket: generation,
    model,
    timer: undefined as unknown as ReturnType<typeof setTimeout>,
  }
  recovery = attempt
  attempt.timer = setTimeout(() => {
    if (recovery === attempt && !stopped) failContext(model.id)
  }, 8000)
  show('正在恢复桌宠画面…')
  report(model.id, 'recovering')
}
function contextRestored() {
  if (
    stopped ||
    !recovery ||
    recovery.ticket !== generation ||
    key !== `${recovery.model.id}/${recovery.model.entry}`
  )
    return
  diagnostics.contextState = 'recovering'
  select(recovery.model, true)
}
canvas.addEventListener('webglcontextlost', contextLost)
canvas.addEventListener('webglcontextrestored', contextRestored)
function render(now: number) {
  animation = 0
  if (stopped || !visible || document.hidden || !session || recovery) {
    stopFrames()
    return
  }
  if (session.isContextLost()) {
    stopAudio()
    stopFrames()
    return
  }
  const active =
    dragging || !bubble.hidden || session.currentAction().kind !== 'idle'
  // Quiet animation stays at 30 FPS in balanced mode; interaction restores 60.
  diagnostics.targetFps = petTargetFps(
    now, lastInteraction, active, performanceMode === 'smooth',
  )
  if (frameBudget.due(now, diagnostics.targetFps)) {
    try {
      audio.tick()
      session.frame(now)
      const lipState = session.lipSyncState()
      diagnostics.lipSyncAppliedFrames = lipState.appliedFrames
      diagnostics.lipSyncParameters = lipState.parameters
      diagnostics.frames++
      diagnostics.totalFrames++
      diagnostics.currentAction = session.currentAction()
      presentation.tick()
    } catch (error) {
      // Context-lost events own recovery; do not replace them with a generic fatal report.
      if (canvas.getContext('webgl2')?.isContextLost()) {
        stopFrames()
        return
      }
      stopFrames()
      session.dispose()
      session = null
      presentation.clear()
      const code =
        error instanceof PetRenderError ? error.code : 'RENDER_FAILED'
      diagnostics.mode = 'error'
      diagnostics.error = code
      canvas.hidden = true
      show(errors[code])
      if (diagnostics.modelId) report(diagnostics.modelId, 'error', code)
    }
    refreshHit()
  }
  wakeFrames()
}
const resize = () => {
  try {
    session?.resize()
  } catch {
    stopAudio()
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
  stopFrames()
  if (document.hidden) {
    stopAudio()
    pointer = null
    endDrag()
    refreshHit()
  }
  if (!document.hidden) {
    frameBudget.reset()
    wakeFrames()
    void poll()
  }
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
    canvas.removeEventListener('webglcontextlost', contextLost)
    canvas.removeEventListener('webglcontextrestored', contextRestored)
    window.removeEventListener('pointerdown', interacted)
    window.removeEventListener('keydown', interacted)
    clear()
    unsubscribeVoiceStop?.()
    audio.dispose()
  },
  { once: true },
)
if (!input) {
  diagnostics.mode = 'error'
  diagnostics.error = 'RUNTIME_MISSING'
  show('桌宠窗口连接未就绪')
} else {
  void poll()
}

import {
  bootLive2D,
  PetRenderError,
  type Live2DSession,
  type PetRenderErrorCode,
  type RuntimeModel,
} from './pet-live2d'
interface PetInput {
  state(): Promise<{ model: RuntimeModel | null; visible: boolean }>
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
    }
  }
}
const canvas = document.getElementById('stage-gl') as HTMLCanvasElement
const message = document.getElementById('pet-status') as HTMLDivElement
const input = window.petInput
const diagnostics = (window.__petRender = {
  mode: 'empty' as 'empty' | 'loading' | 'live2d' | 'live2d-idle' | 'error',
  error: null as PetRenderErrorCode | null,
  frames: 0,
  modelId: null as string | null,
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
const show = (text: string) => {
  message.textContent = text
  message.hidden = !text
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
function clear() {
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
    visible = result.visible
    if (!visible) session?.pause()
    select(result.model)
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

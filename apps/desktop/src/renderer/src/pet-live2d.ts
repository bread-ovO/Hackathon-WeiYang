import { createDeclaredLipSync } from './pet-lip-sync'
import {
  guardShaderRegistration,
  type ShaderRegistration,
} from './pet-shader-lifecycle'
import { parsePetActionCatalog } from '@memo/contracts/pet-actions'
import {
  createAlphaHitMap,
  HIT_MAP_SIZE,
  HIT_MAP_INTERVAL_MS,
} from './pet-hit-test'
/** Production renderer: only host-controlled memo-pet resources, never model scripts. */
export interface RuntimeModel {
  id: string
  entry: string
}
export type PetRenderErrorCode =
  | 'RUNTIME_MISSING'
  | 'MODEL_LOAD_FAILED'
  | 'MOC3_INVALID'
  | 'WEBGL_UNAVAILABLE'
  | 'TEXTURE_INVALID'
  | 'MOTION_INVALID'
  | 'PHYSICS_INVALID'
  | 'SHADER_TIMEOUT'
  | 'RENDER_FAILED'
export class PetRenderError extends Error {
  constructor(readonly code: PetRenderErrorCode) {
    super(code)
  }
}
export interface Live2DSession {
  readonly lipSyncAvailable: boolean
  setLipSyncLevel(level: number | null): void
  lipSyncState(): {
    appliedFrames: number
    parameters: { index: number; value: number }[]
  }
  mode: 'live2d' | 'live2d-idle'
  play(actionId: string): Promise<{ status: 'playing' | 'unavailable' }>
  currentAction(): { id: string | null; kind: 'idle' | 'motion' | 'expression' }
  frame(now: number): void
  hitTest(x: number, y: number, width: number, height: number): boolean
  isContextLost(): boolean
  pause(): void
  resize(): void
  dispose(): void
}
type Id = object
interface Matrix {
  scale(x: number, y: number): void
  translate(x: number, y: number): void
}
interface Model {
  update(): void
  saveParameters(): void
  loadParameters(): void
  getParameterCount(): number
  getParameterId(index: number): Id
  getParameterValueByIndex(index: number): number
  getParameterMinimumValue(index: number): number
  getParameterMaximumValue(index: number): number
  setParameterValueByIndex(index: number, value: number): void
  getDrawableCount(): number
  getDrawableVertexPositions(index: number): Float32Array
}

interface Motion {
  setLoop(value: boolean): void
  setEffectIds(eye: Id[], lip: Id[]): void
  release(): void
}
interface MotionManager {
  startMotionPriority(
    motion: Motion,
    autoDelete: boolean,
    priority: number,
  ): unknown
  updateMotion(model: Model, delta: number): boolean
  isFinished(): boolean
  stopAllMotions(): void
  release(): void
}
interface Setting {
  getModelFileName(): string
  getTextureCount(): number
  getTextureFileName(index: number): string
  getEyeBlinkParameterCount(): number
  getEyeBlinkParameterId(index: number): Id
  getLipSyncParameterCount(): number
  getLipSyncParameterId(index: number): Id
  getMotionCount(group: string): number
  getMotionFileName(group: string, index: number): string
  getPhysicsFileName(): string
  getPoseFileName(): string
  release(): void
}
interface Renderer {
  initialize(model: Model): void
  startUp(gl: WebGL2RenderingContext): void
  loadShaders(path: string): void
  setIsPremultipliedAlpha(value: boolean): void
  bindTexture(index: number, texture: WebGLTexture): void
  setMvpMatrix(matrix: Matrix): void
  setRenderState(buffer: null, viewport: number[]): void
  drawModel(path: string): void
  release(): void
}
interface Framework {
  CubismFramework: {
    startUp(): boolean
    initialize(): void
    dispose(): void
    cleanUp(): void
    getIdManager(): { getId(id: string): Id }
  }
  CubismModelSettingJson: new (buffer: ArrayBuffer, size: number) => Setting
  CubismMoc: {
    create(
      buffer: ArrayBuffer,
      check: boolean,
    ): {
      createModel(): Model | null
      deleteModel(model: Model): void
      release(): void
    } | null
  }
  CubismMatrix44: new () => Matrix
  CubismShaderManager_WebGL: {
    getInstance(): { getShader(gl: WebGL2RenderingContext): ShaderRegistration }
  }
  CubismRenderer_WebGL: {
    new (width: number, height: number): Renderer
    doStaticRelease(): void
  }
  CubismMotion: {
    create(
      buffer: ArrayBuffer,
      size: number,
      finished?: unknown,
      began?: unknown,
      check?: boolean,
    ): Motion | null
  }
  CubismExpressionMotion: {
    create(buffer: ArrayBuffer, size: number): { release(): void } | null
  }
  CubismExpressionMotionManager: new () => {
    startMotion(motion: { release(): void }, autoDelete: boolean): unknown
    updateMotion(model: Model, delta: number): boolean
    stopAllMotions(): void
    release(): void
  }
  CubismMotionManager: new () => MotionManager
  CubismPhysics: {
    create(
      buffer: ArrayBuffer,
      size: number,
    ): { evaluate(model: Model, delta: number): void; release(): void } | null
  }
  CubismPose: {
    create(
      buffer: ArrayBuffer,
      size: number,
    ): { updateParameters(model: Model, delta: number): void } | null
  }
}
const runtime = 'memo-pet://app/runtime/'
const shaders = `${runtime}shaders/`
const scripts = new Map<string, Promise<void>>()
function loadScript(name: 'core.js' | 'framework.js'): Promise<void> {
  const src = runtime + name
  const existing = scripts.get(src)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    const timer = setTimeout(() => {
      script.remove()
      reject(new PetRenderError('RUNTIME_MISSING'))
    }, 10000)
    script.onload = () => {
      clearTimeout(timer)
      resolve()
    }
    script.onerror = () => {
      clearTimeout(timer)
      script.remove()
      reject(new PetRenderError('RUNTIME_MISSING'))
    }
    document.head.appendChild(script)
  })
  scripts.set(src, promise)
  void promise.catch(() => {
    if (scripts.get(src) === promise) scripts.delete(src)
  })
  return promise
}
const cancelled = () => new DOMException('Rendering cancelled', 'AbortError')
function check(signal: AbortSignal) {
  if (signal.aborted) throw cancelled()
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal)
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(cancelled())
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) reject(cancelled())
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
const safePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\\:%?#\x00-\x1f\x7f]/.test(value) &&
  value.split('/').every((x) => x !== '' && x !== '.' && x !== '..')
async function bytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  check(signal)
  const controller = new AbortController(),
    abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
    })
    if (!response.ok) throw new Error('resource unavailable')
    const result = await response.arrayBuffer()
    check(signal)
    return result
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
/** Caller serializes sessions: dispose the old one before starting another because
 * the pinned Framework owns process-global IDs and shaders. Abort always releases
 * partially created model/GPU state; the session owns all subsequent cleanup. */
export async function bootLive2D(
  canvas: HTMLCanvasElement,
  selected: RuntimeModel,
  signal: AbortSignal,
): Promise<Live2DSession> {
  const modelInfo = { id: selected.id, entry: selected.entry }
  let failure: PetRenderErrorCode = 'RUNTIME_MISSING',
    disposed = false,
    lastTime: number | undefined,
    elapsed = 0
  let context: WebGL2RenderingContext | null = null
  let closeShaderGate = () => {}
  const release: Array<() => void> = []
  const dispose = () => {
    if (disposed) return
    disposed = true
    closeShaderGate()
    while (release.length) {
      const cleanup = release.pop()!
      try {
        cleanup()
      } catch {
        /* Complete all remaining cleanup. */
      }
    }
  }
  try {
    check(signal)
    await abortable(loadScript('core.js'), signal)
    await abortable(loadScript('framework.js'), signal)
    check(signal)
    const globals = window as unknown as {
      Live2DCubismFramework?: Framework
      Live2DCubismCore?: unknown
    }
    const F = globals.Live2DCubismFramework
    if (!F || !globals.Live2DCubismCore) throw new Error('runtime missing')
    if (!F.CubismFramework.startUp()) throw new Error('startup failed')
    release.push(() => F.CubismFramework.cleanUp())
    F.CubismFramework.initialize()
    release.push(() => F.CubismFramework.dispose())
    failure = 'MODEL_LOAD_FAILED'
    if (
      !/^[a-f0-9]{64}$/.test(modelInfo.id) ||
      !safePath(modelInfo.entry) ||
      !modelInfo.entry.endsWith('.model3.json')
    )
      throw new Error('invalid entry')
    const base = `memo-pet://app/models/${modelInfo.id}/`
    const directory = modelInfo.entry.includes('/')
      ? modelInfo.entry.slice(0, modelInfo.entry.lastIndexOf('/') + 1)
      : ''
    const resource = (name: string) => {
      if (!safePath(name)) throw new Error('invalid resource')
      return (
        base + directory + name.split('/').map(encodeURIComponent).join('/')
      )
    }
    const manifest = await bytes(
      base + modelInfo.entry.split('/').map(encodeURIComponent).join('/'),
      signal,
    )
    const setting = new F.CubismModelSettingJson(manifest, manifest.byteLength)
    release.push(() => setting.release())
    failure = 'MOC3_INVALID'
    const moc = F.CubismMoc.create(
      await bytes(resource(setting.getModelFileName()), signal),
      true,
    )
    if (!moc) throw new Error('invalid moc')
    release.push(() => moc.release())
    const model = moc.createModel()
    if (!model) throw new Error('invalid model')
    release.push(() => moc.deleteModel(model))
    const parameterCount = model.getParameterCount(),
      drawableCount = model.getDrawableCount()
    if (parameterCount <= 0 || drawableCount <= 0)
      throw new Error('empty model')
    const defaults = Array.from({ length: parameterCount }, (_, i) =>
      model.getParameterValueByIndex(i),
    )
    model.saveParameters()
    failure = 'WEBGL_UNAVAILABLE'
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      antialias: false,
      alpha: true,
    })
    if (!gl) throw new Error('WebGL2 required')
    context = gl
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (let i = 0; i < drawableCount; i++) {
      const vertices = model.getDrawableVertexPositions(i)
      for (let j = 0; j < vertices.length; j += 2) {
        const x = vertices[j]!,
          y = vertices[j + 1]!
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error('bad geometry')
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    if (maxX <= minX || maxY <= minY) throw new Error('empty geometry')
    const renderer = new F.CubismRenderer_WebGL(1, 1)
    release.push(() => F.CubismRenderer_WebGL.doStaticRelease())
    release.push(() => renderer.release())
    renderer.initialize(model)
    renderer.startUp(gl)
    closeShaderGate = guardShaderRegistration(
      F.CubismShaderManager_WebGL.getInstance().getShader(gl),
    )
    renderer.setIsPremultipliedAlpha(true)
    let viewportWidth = 0,
      viewportHeight = 0
    const resize = () => {
      const ratio = Math.min(2, devicePixelRatio || 1),
        width = Math.max(
          1,
          Math.min(2048, Math.round(canvas.clientWidth * ratio)),
        ),
        height = Math.max(
          1,
          Math.min(2048, Math.round(canvas.clientHeight * ratio)),
        )
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      if (viewportWidth === width && viewportHeight === height) return
      viewportWidth = width
      viewportHeight = height
      // Fit native model geometry to the viewport with uniform pixel scale.
      const scale =
          0.92 * Math.min(width / (maxX - minX), height / (maxY - minY)),
        sx = (2 * scale) / width,
        sy = (2 * scale) / height
      const matrix = new F.CubismMatrix44()
      matrix.scale(sx, sy)
      matrix.translate(-(minX + maxX) * 0.5 * sx, -(minY + maxY) * 0.5 * sy)
      renderer.setMvpMatrix(matrix)
    }
    resize()
    failure = 'TEXTURE_INVALID'
    const count = setting.getTextureCount()
    if (count < 1 || count > 256) throw new Error('invalid texture count')
    for (let i = 0; i < count; i++) {
      const data = await bytes(resource(setting.getTextureFileName(i)), signal)
      const bitmap = await createImageBitmap(
        new Blob([data], { type: 'image/png' }),
        { premultiplyAlpha: 'premultiply' },
      )
      try {
        check(signal)
        if (
          bitmap.width > 8192 ||
          bitmap.height > 8192 ||
          bitmap.width * bitmap.height > 16 * 1024 * 1024
        )
          throw new Error('texture limit')
        const texture = gl.createTexture()
        if (!texture) throw new Error('texture allocation failed')
        release.push(() => gl.deleteTexture(texture))
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bitmap,
        )
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        )
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.generateMipmap(gl.TEXTURE_2D)
        renderer.bindTexture(i, texture)
      } finally {
        bitmap.close()
      }
    }
    failure = 'MOTION_INVALID'
    const eyeIds = Array.from(
      { length: setting.getEyeBlinkParameterCount() },
      (_, i) => setting.getEyeBlinkParameterId(i),
    )
    const lipIds = Array.from(
      { length: setting.getLipSyncParameterCount() },
      (_, i) => setting.getLipSyncParameterId(i),
    )
    const lipSync = createDeclaredLipSync(model, lipIds)
    release.push(() => lipSync.set(null))
    let manager: MotionManager | undefined
    let idleMotion: Motion | undefined
    // Optional/broken Idle never prevents the actual model from rendering.
    if (setting.getMotionCount('Idle') > 0) {
      try {
        const data = await bytes(
          resource(setting.getMotionFileName('Idle', 0)),
          signal,
        )
        const motion = F.CubismMotion.create(
          data,
          data.byteLength,
          undefined,
          undefined,
          true,
        )
        if (!motion) throw new Error('invalid idle motion')
        idleMotion = motion
        release.push(() => motion.release())
        motion.setLoop(true)
        motion.setEffectIds(eyeIds, lipIds)
        manager = new F.CubismMotionManager()
        const ownedManager = manager
        release.push(() => ownedManager.release())
        if (manager.startMotionPriority(motion, false, 3) === -1)
          throw new Error('idle unavailable')
      } catch {
        check(signal)
        manager?.stopAllMotions()
        idleMotion = undefined
      }
    }
    if (!manager) {
      manager = new F.CubismMotionManager()
      const ownedManager = manager
      release.push(() => ownedManager.release())
    }
    const actionManager = manager
    let action: { id: string | null; kind: 'idle' | 'motion' | 'expression' } =
      { id: null, kind: 'idle' }
    let actionGeneration = 0,
      actionAbort: AbortController | undefined
    let preview: Motion | undefined
    let expression: { release(): void } | undefined
    let expressionManager:
      | InstanceType<Framework['CubismExpressionMotionManager']>
      | undefined
    let actionSeconds = 0
    const stopPreview = () => {
      // Detach ownership first and attempt every release even if an SDK object
      // throws while the context is lost. Repeated disposal is a no-op.
      const manager = expressionManager,
        motion = preview,
        face = expression
      expressionManager = undefined
      preview = undefined
      expression = undefined
      const operations = [
        () => actionManager.stopAllMotions(),
        () => manager?.stopAllMotions(),
        () => manager?.release(),
        () => motion?.release(),
        () => face?.release(),
      ]
      for (const cleanup of operations) {
        try {
          cleanup()
        } catch {
          /* Continue the independent releases. */
        }
      }
    }
    const resumeIdle = () => {
      stopPreview()
      action = { id: null, kind: 'idle' }
      actionSeconds = 0
      for (let i = 0; i < defaults.length; i++)
        model.setParameterValueByIndex(i, defaults[i]!)
      model.saveParameters()
      if (idleMotion) actionManager.startMotionPriority(idleMotion, false, 3)
    }
    release.push(() => {
      actionGeneration++
      actionAbort?.abort()
      stopPreview()
      action = { id: null, kind: 'idle' }
    })
    // IDs resolve exclusively through the validated, bounded manifest catalog.
    const actionFiles = new Map<
      string,
      { path: string; kind: 'motion' | 'expression' }
    >()
    try {
      const raw: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(manifest),
      )
      const catalog = parsePetActionCatalog(raw)
      const refs = (
        raw as {
          FileReferences: {
            Motions?: Record<string, { File: string }[]>
            Expressions?: { File: string }[]
          }
        }
      ).FileReferences
      const groups = Object.keys(refs.Motions ?? {})
      for (const item of catalog.motions) {
        const [, g, m] = item.id.split(':')
        const path = refs.Motions?.[groups[Number(g)]!]?.[Number(m)]?.File
        if (safePath(path)) actionFiles.set(item.id, { path, kind: 'motion' })
      }
      for (const item of catalog.expressions) {
        const path = refs.Expressions?.[Number(item.id.split(':')[1])]?.File
        if (safePath(path))
          actionFiles.set(item.id, { path, kind: 'expression' })
      }
    } catch {
      /* Invalid optional catalog degrades to ordinary Idle. */
    }
    const play = async (
      actionId: string,
    ): Promise<{ status: 'playing' | 'unavailable' }> => {
      if (disposed || signal.aborted || gl.isContextLost())
        return { status: 'unavailable' }
      const ticket = ++actionGeneration
      actionAbort?.abort()
      const file = actionFiles.get(actionId)
      if (!file) {
        resumeIdle()
        return { status: 'unavailable' }
      }
      const local = new AbortController()
      actionAbort = local
      const abort = () => local.abort()
      signal.addEventListener('abort', abort, { once: true })
      let loaded: { release(): void } | undefined
      try {
        const data = await bytes(resource(file.path), local.signal)
        if (
          disposed ||
          ticket !== actionGeneration ||
          local.signal.aborted ||
          gl.isContextLost()
        )
          return { status: 'unavailable' }
        if (file.kind === 'motion') {
          const motion = F.CubismMotion.create(
            data,
            data.byteLength,
            undefined,
            undefined,
            true,
          )
          if (!motion) throw new Error('motion unavailable')
          loaded = motion
          motion.setLoop(false)
          motion.setEffectIds(eyeIds, lipIds)
          resumeIdle()
          actionManager.stopAllMotions()
          if (actionManager.startMotionPriority(motion, false, 3) === -1)
            throw new Error('motion unavailable')
          preview = motion
        } else {
          const candidate = F.CubismExpressionMotion.create(
            data,
            data.byteLength,
          )
          if (!candidate) throw new Error('expression unavailable')
          loaded = candidate
          resumeIdle()
          expressionManager = new F.CubismExpressionMotionManager()
          if (expressionManager.startMotion(candidate, false) === -1)
            throw new Error('expression unavailable')
          expression = candidate
        }
        loaded = undefined
        action = { id: actionId, kind: file.kind }
        actionSeconds = 0
        return { status: 'playing' }
      } catch {
        if (!disposed && ticket === actionGeneration && !signal.aborted)
          resumeIdle()
        return { status: 'unavailable' }
      } finally {
        loaded?.release()
        signal.removeEventListener('abort', abort)
        if (actionAbort === local) actionAbort = undefined
      }
    }
    failure = 'PHYSICS_INVALID'
    let physics: ReturnType<Framework['CubismPhysics']['create']> | undefined
    if (setting.getPhysicsFileName()) {
      const data = await bytes(resource(setting.getPhysicsFileName()), signal)
      physics = F.CubismPhysics.create(data, data.byteLength)
      if (!physics) throw new Error('invalid physics')
      const ownedPhysics = physics
      release.push(() => ownedPhysics.release())
    }
    // The pose file toggles visibility between overlapping part groups (for
    // example crossed arms versus resting hands). Without it every variant
    // draws at once. Optional like Idle: a broken pose degrades, never blocks.
    // CubismPose holds no GPU/native state, so GC reclaims it with the session.
    let pose:
      | ReturnType<Framework['CubismPose']['create']>
      | undefined
    if (setting.getPoseFileName()) {
      try {
        const data = await bytes(resource(setting.getPoseFileName()), signal)
        pose = F.CubismPose.create(data, data.byteLength) ?? undefined
      } catch {
        check(signal)
        pose = undefined
      }
    }
    const ids = F.CubismFramework.getIdManager(),
      breathId = ids.getId('ParamBreath')
    const breathIndex = Array.from(
      { length: parameterCount },
      (_, i) => i,
    ).find((i) => model.getParameterId(i) === breathId)
    const eyeIndexes = Array.from(
      { length: parameterCount },
      (_, i) => i,
    ).filter((i) => eyeIds.includes(model.getParameterId(i)))
    const hitMap = createAlphaHitMap()
    release.push(() => hitMap.clear())
    const hitTexture = gl.createTexture(),
      hitBuffer = gl.createFramebuffer()
    if (!hitTexture || !hitBuffer) {
      if (hitTexture) gl.deleteTexture(hitTexture)
      if (hitBuffer) gl.deleteFramebuffer(hitBuffer)
      throw new PetRenderError('RENDER_FAILED')
    }
    release.push(
      () => gl.deleteTexture(hitTexture),
      () => gl.deleteFramebuffer(hitBuffer),
    )
    gl.bindTexture(gl.TEXTURE_2D, hitTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      HIT_MAP_SIZE,
      HIT_MAP_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.bindFramebuffer(gl.FRAMEBUFFER, hitBuffer)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      hitTexture,
      0,
    )
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new PetRenderError('RENDER_FAILED')
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const hitPixels = new Uint8Array(HIT_MAP_SIZE * HIT_MAP_SIZE * 4)
    let lastHitRead = -Infinity
    const updateHitMap = () => {
      const now = performance.now()
      if (now - lastHitRead < HIT_MAP_INTERVAL_MS) return
      lastHitRead = now
      const scissorEnabled = gl.isEnabled(gl.SCISSOR_TEST)
      try {
        gl.disable(gl.SCISSOR_TEST)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hitBuffer)
        gl.blitFramebuffer(
          0,
          0,
          canvas.width,
          canvas.height,
          0,
          0,
          HIT_MAP_SIZE,
          HIT_MAP_SIZE,
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        )
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, hitBuffer)
        gl.readPixels(
          0,
          0,
          HIT_MAP_SIZE,
          HIT_MAP_SIZE,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          hitPixels,
        )
        hitMap.update(hitPixels)
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        if (scissorEnabled) gl.enable(gl.SCISSOR_TEST)
      }
    }
    const draw = () => {
      if (disposed || gl.isContextLost()) return
      resize()
      model.update()
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      renderer.setRenderState(null, [0, 0, canvas.width, canvas.height])
      renderer.drawModel(shaders)
      updateHitMap()
      if (!gl.isContextLost() && gl.getError() !== gl.NO_ERROR)
        throw new PetRenderError('RENDER_FAILED')
    }
    failure = 'SHADER_TIMEOUT'
    renderer.loadShaders(shaders)
    let deadline = performance.now() + 10000
    while (true) {
      check(signal)
      if (document.hidden) {
        const began = performance.now()
        await abortable(
          new Promise((resolve) => setTimeout(resolve, 100)),
          signal,
        )
        deadline += performance.now() - began
        continue
      }
      if (gl.isContextLost()) {
        // Give the window's contextlost handler time to abort this in-flight boot.
        if (performance.now() > deadline) throw cancelled()
        await abortable(
          new Promise((resolve) => setTimeout(resolve, 50)),
          signal,
        )
        continue
      }
      draw()
      const pixels = new Uint8Array(canvas.width * canvas.height * 4)
      gl.readPixels(
        0,
        0,
        canvas.width,
        canvas.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      )
      if (pixels.some((value, index) => index % 4 === 3 && value > 0)) break
      if (performance.now() > deadline) throw new Error('no visible model')
      await abortable(new Promise((resolve) => setTimeout(resolve, 50)), signal)
    }
    const onAbort = () => dispose()
    signal.addEventListener('abort', onAbort, { once: true })
    release.push(() => signal.removeEventListener('abort', onAbort))
    check(signal)
    return {
      lipSyncAvailable: lipSync.available,
      setLipSyncLevel: (level) => lipSync.set(level),
      lipSyncState: () => lipSync.state(),
      mode: idleMotion ? 'live2d' : 'live2d-idle',
      play,
      currentAction: () => ({ ...action }),
      hitTest: (x, y, width, height) =>
        !disposed && !gl.isContextLost() && hitMap.hit(x, y, width, height),
      resize() {
        if (!disposed && !gl.isContextLost()) resize()
      },
      isContextLost: () => gl.isContextLost(),
      pause() {
        lastTime = undefined
      },
      dispose,
      frame(now) {
        if (disposed || signal.aborted) return
        if (gl.isContextLost()) {
          lastTime = undefined
          return
        }
        if (document.hidden) {
          lastTime = undefined
          return
        }
        const delta =
          lastTime === undefined
            ? 1 / 60
            : Math.min(0.1, Math.max(0, (now - lastTime) / 1000))
        lastTime = now
        elapsed += delta
        try {
          model.loadParameters()
          try {
            if (idleMotion || action.kind === 'motion')
              actionManager.updateMotion(model, delta)
            actionSeconds += delta
            if (
              (action.kind === 'motion' &&
                (actionManager.isFinished() || actionSeconds >= 30)) ||
              (action.kind === 'expression' && actionSeconds >= 3)
            )
              resumeIdle()
          } catch {
            resumeIdle()
          }
          // No motion? Animate only existing native parameters; no substitute drawing.
          if (!idleMotion && action.kind !== 'motion') {
            if (breathIndex !== undefined) {
              const min = model.getParameterMinimumValue(breathIndex),
                max = model.getParameterMaximumValue(breathIndex)
              model.setParameterValueByIndex(
                breathIndex,
                min +
                  (max - min) * (0.5 + 0.5 * Math.sin((elapsed * Math.PI) / 2)),
              )
            }
            const phase = elapsed % 4,
              blink = phase < 0.16 ? Math.abs(phase - 0.08) / 0.08 : 1
            for (const index of eyeIndexes)
              model.setParameterValueByIndex(
                index,
                Math.min(
                  model.getParameterMaximumValue(index),
                  Math.max(model.getParameterMinimumValue(index), blink),
                ),
              )
          }
          model.saveParameters()
          try {
            expressionManager?.updateMotion(model, delta)
          } catch {
            resumeIdle()
          }
          physics?.evaluate(model, delta)
          pose?.updateParameters(model, delta)
          lipSync.apply()
          draw()
        } catch (error) {
          if (gl.isContextLost()) {
            lastTime = undefined
            return
          }
          dispose()
          throw error instanceof PetRenderError
            ? error
            : new PetRenderError('RENDER_FAILED')
        }
      },
    }
  } catch (error) {
    dispose()
    if (context?.isContextLost() && !signal.aborted) {
      // Context events are queued by the browser after loss is observed.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (signal.aborted) throw cancelled()
    throw error instanceof PetRenderError ? error : new PetRenderError(failure)
  }
}

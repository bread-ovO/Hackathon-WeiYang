// PET06: drives the real Cubism pipeline inside the pet window. Every API
// call sequence was verified in PET01 (docs/engineering/PET01_Cubism_SDK
// 兼容性验证_2026-09-13.md) — the pitfalls list there applies to this file.

export interface RuntimeModel {
  id: string
  entry: string
}
export interface Live2DSession {
  mode: 'live2d' | 'breathing-only'
  frame(now: number): void
  alphaAt(cssX: number, cssY: number): number
  dispose(): void
}

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-live2d="${src}"]`,
    )
    if (existing) {
      if (existing.dataset.loaded === '1') resolve()
      else {
        existing.addEventListener('load', () => resolve(), { once: true })
        existing.addEventListener(
          'error',
          () => reject(new Error('SCRIPT_LOAD_FAILED')),
          { once: true },
        )
      }
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.dataset.live2d = src
    script.addEventListener(
      'load',
      () => {
        script.dataset.loaded = '1'
        resolve()
      },
      { once: true },
    )
    script.addEventListener('error', () => reject(new Error('SCRIPT_LOAD_FAILED')), {
      once: true,
    })
    document.head.appendChild(script)
  })

interface Framework {
  CubismFramework: { startUp(): boolean; initialize(): void }
  CubismMoc: { create(bytes: ArrayBuffer, check: boolean): unknown }
  CubismMotion: { create(buffer: ArrayBuffer, size: number): unknown }
  CubismMotionManager: new () => {
    startMotionPriority(motion: unknown, t: number, priority: number): unknown
    updateMotion(model: unknown, t: number): boolean
  }
  CubismModelSettingJson: new (buffer: ArrayBuffer) => {
    getModelFileName(): string
    getTextureCount(): number
    getTextureFileName(i: number): string
    getEyeBlinkParameterCount(): number
    getEyeBlinkParameterId(i: number): unknown
    getLipSyncParameterCount(): number
    getLipSyncParameterId(i: number): unknown
    getMotionCount(group: string): number
    getMotionFileName(group: string, i: number): string
  }
  CubismRenderer_WebGL: new (w: number, h: number) => {
    initialize(model: unknown): void
    startUp(gl: WebGLRenderingContext): void
    loadShaders(path: string): void
    setIsPremultipliedAlpha(v: boolean): void
    bindTexture(slot: number, texture: WebGLTexture): void
    setRenderState(fb: null, viewport: number[]): void
    drawModel(shaderPath: string): void
    release?(): void
  }
}

const fetchBuf = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(`FETCH_FAILED ${url}`)
    return r.arrayBuffer()
  })

/** Boots the full pipeline for one controlled model. Throws on hard
 * failures (bad moc3, missing core) so the caller can degrade honestly. */
export async function bootLive2D(
  canvas: HTMLCanvasElement,
  model: RuntimeModel,
): Promise<Live2DSession> {
  await loadScript('/live2d/live2dcubismcore.min.js')
  await loadScript('/live2d/live2dcubismframework.min.js')
  const core = (window as unknown as { Live2DCubismCore?: unknown })
    .Live2DCubismCore
  const F = (window as unknown as { Live2DCubismFramework?: Framework })
    .Live2DCubismFramework
  if (!core || !F) throw new Error('RUNTIME_MISSING')
  F.CubismFramework.startUp()
  F.CubismFramework.initialize()

  const base = `/models/${model.id}`
  const entryDir = model.entry.includes('/')
    ? `${model.entry.slice(0, model.entry.lastIndexOf('/'))}/`
    : ''
  // Manifest resource paths are relative to the manifest, not the model root.
  const resource = (name: string) => `${base}/${entryDir}${name}`
  const setting = new F.CubismModelSettingJson(
    await fetchBuf(`${base}/${model.entry}`),
  )
  const moc = F.CubismMoc.create(
    await fetchBuf(resource(setting.getModelFileName())),
    true,
  )
  if (!moc) throw new Error('MOC3_INVALID')
  const cubismModel = (
    moc as { createModel(): { initialize(): void } & Record<string, unknown> }
  ).createModel()
  cubismModel.initialize()

  const gl = canvas.getContext('webgl', {
    premultipliedAlpha: true,
    alpha: true,
    // Hit-testing (PET08) reads pixels between frames.
    preserveDrawingBuffer: true,
  })
  if (!gl) throw new Error('WEBGL_UNAVAILABLE')
  const renderer = new F.CubismRenderer_WebGL(canvas.width, canvas.height)
  renderer.initialize(cubismModel)
  renderer.startUp(gl)
  renderer.loadShaders('/live2d/shaders/')
  renderer.setIsPremultipliedAlpha(true)

  const textures: WebGLTexture[] = []
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
  const textureCount = setting.getTextureCount()
  for (let i = 0; i < textureCount; i++) {
    const image = new Image()
    image.src = resource(setting.getTextureFileName(i))
    await image.decode()
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.generateMipmap(gl.TEXTURE_2D)
    renderer.bindTexture(i, texture)
    textures.push(texture)
  }

  const collectIds = (count: number, id: (i: number) => unknown) => {
    const ids: unknown[] = []
    for (let i = 0; i < count; i++) ids.push(id(i))
    return ids
  }
  // Idle motion is optional per PET06 acceptance: breathe-only when absent.
  let motionManager: InstanceType<Framework['CubismMotionManager']> | null = null
  if (setting.getMotionCount('Idle') > 0) {
    const buffer = await fetchBuf(resource(setting.getMotionFileName('Idle', 0)))
    const motion = F.CubismMotion.create(buffer, buffer.byteLength) as
      | { setLoop(v: boolean): void; setEffectIds(eye: unknown[], lip: unknown[]): void }
      | null
    if (motion) {
      // setEffectIds must run before the first update (PET01 pitfall #3);
      // looping the idle makes the pet return to standby automatically.
      motion.setEffectIds(
        collectIds(setting.getEyeBlinkParameterCount(), (i) =>
          setting.getEyeBlinkParameterId(i),
        ),
        collectIds(setting.getLipSyncParameterCount(), (i) =>
          setting.getLipSyncParameterId(i),
        ),
      )
      motion.setLoop(true)
      motionManager = new F.CubismMotionManager()
      motionManager.startMotionPriority(motion, 0, 3)
    }
  }

  const modelParam = cubismModel as unknown as {
    setParameterValueById(id: string, value: number): void
    update(): void
  }
  let disposed = false
  return {
    mode: motionManager ? 'live2d' : 'breathing-only',
    frame(now) {
      if (disposed) return
      const seconds = now / 1000
      modelParam.setParameterValueById('ParamBreath', (Math.sin(seconds * 1.6) + 1) / 2)
      motionManager?.updateMotion(cubismModel, seconds)
      modelParam.update()
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      renderer.setRenderState(null, [0, 0, canvas.width, canvas.height])
      renderer.drawModel('/live2d/shaders/')
    },
    /** PET08 hit-test on the composited model pixels. */
    alphaAt(cssX: number, cssY: number): number {
      const x = Math.round(cssX * (canvas.width / canvas.clientWidth))
      const y = Math.round(cssY * (canvas.height / canvas.clientHeight))
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return 0
      const pixel = new Uint8Array(4)
      gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      return pixel[3]!
    },
    dispose() {
      if (disposed) return
      disposed = true
      // PET06: switching must release GPU resources, not just drop them.
      for (const texture of textures) gl.deleteTexture(texture)
      renderer.release?.()
    },
  }
}

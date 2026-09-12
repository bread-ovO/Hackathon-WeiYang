// Official SDK 5-r.5 development-only verification. Licensed assets stay in
// .pet-sdk; this harness is not the product's model-import validator/renderer.
;(async () => {
  const F = window.Live2DCubismFramework
  const state = (window.__petVerify = {
    steps: {},
    wasmAllowed: null,
    coreVersion: null,
    modelLoaded: false,
    paramCount: 0,
    drawableCount: 0,
    textureCount: 0,
    webglVersion: null,
    frames: [],
    nonTransparentPixels: [],
    parameterFrames: [],
    motionUpdated: [],
    negativeMoc3Error: null,
    negativeMoc3: { frameworkRejected: false, coreRejected: false },
    resourcesReleased: false,
    cleanupErrors: [],
    error: null,
    done: false,
  })
  const releases = []
  const describe = (error) => String(error?.message ?? error)
  const rejectAsync = (event) => {
    state.error ??= `unhandled-promise: ${describe(event.reason)}`
  }
  window.addEventListener('unhandledrejection', rejectAsync)
  const step = async (name, operation) => {
    try {
      const value = await operation()
      if (state.error) throw new Error(state.error)
      state.steps[name] = { ok: true, value }
      return value
    } catch (error) {
      state.steps[name] = { ok: false, error: describe(error) }
      state.error ??= `${name}: ${describe(error)}`
      throw error
    }
  }
  const fetchBuf = async (url) => {
    const response = await fetch(url)
    if (!response.ok)
      throw new Error(`fixture-resource HTTP ${response.status}`)
    return response.arrayBuffer()
  }
  const wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
  try {
    await step('wasm-probe', async () => {
      try {
        await WebAssembly.compile(
          Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]),
        )
        state.wasmAllowed = true
      } catch {
        state.wasmAllowed = false
      }
      return state.wasmAllowed
    })
    await step('core-loaded', () => {
      if (!window.Live2DCubismCore || !F) throw new Error('SDK globals missing')
      return true
    })
    await step('core-version', () => {
      const value = window.Live2DCubismCore.Version.csmGetVersion() >>> 0
      state.coreVersion = `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255} (0x${value.toString(16)})`
      return state.coreVersion
    })
    await step('framework-init', () => {
      if (!F.CubismFramework.startUp())
        throw new Error('Framework startup failed')
      releases.push(() => F.CubismFramework.cleanUp())
      F.CubismFramework.initialize()
      releases.push(() => F.CubismFramework.dispose())
      return true
    })
    const setting = await step('model-setting', async () => {
      const buffer = await fetchBuf('model/Haru.model3.json')
      const result = new F.CubismModelSettingJson(buffer, buffer.byteLength)
      releases.push(() => result.release())
      return result
    })
    // Keep step output serializable; never expose native SDK resource objects.
    state.steps['model-setting'].value = 'model3.json parsed'
    const canvas = document.getElementById('stage')
    const gl = await step('webgl-context', () => {
      if (!(canvas instanceof HTMLCanvasElement))
        throw new Error('stage canvas missing')
      canvas.width = 512
      canvas.height = 512
      const context = canvas.getContext('webgl2', {
        premultipliedAlpha: true,
        alpha: true,
      })
      if (!context) throw new Error('WebGL2 unavailable')
      state.webglVersion = 2
      return context
    })
    state.steps['webgl-context'].value = 'WebGL2'
    const model = await step('moc-load', async () => {
      const moc = F.CubismMoc.create(
        await fetchBuf(`model/${setting.getModelFileName()}`),
        true,
      )
      if (moc === null)
        throw new Error('official Haru moc failed consistency check')
      releases.push(() => moc.release())
      const result = moc.createModel() // createModel already calls initialize in 5-r.5.
      if (result === null) throw new Error('moc.createModel failed')
      releases.push(() => moc.deleteModel(result))
      state.paramCount = result.getParameterCount()
      state.drawableCount = result.getDrawableCount()
      if (state.paramCount <= 0 || state.drawableCount <= 0)
        throw new Error('empty model')
      result.saveParameters()
      state.modelLoaded = true
      return result
    })
    state.steps['moc-load'].value =
      `params=${state.paramCount} drawables=${state.drawableCount}`
    await step('bad-moc-rejected', () => {
      const garbage = new Uint8Array(64).fill(0x23)
      const frameworkMoc = F.CubismMoc.create(garbage.buffer, true)
      const coreMoc = window.Live2DCubismCore.Moc.fromArrayBuffer(
        garbage.buffer,
      )
      state.negativeMoc3.frameworkRejected = frameworkMoc === null
      state.negativeMoc3.coreRejected = coreMoc === null
      if (frameworkMoc !== null) releases.push(() => frameworkMoc.release())
      if (coreMoc !== null) releases.push(() => coreMoc._release())
      if (
        !state.negativeMoc3.frameworkRejected ||
        !state.negativeMoc3.coreRejected
      )
        throw new Error('invalid moc must be null in both Framework and Core')
      state.negativeMoc3Error = 'framework=null, core=null'
      return state.negativeMoc3Error
    })
    const renderer = await step('textures-bound', async () => {
      const result = new F.CubismRenderer_WebGL(canvas.width, canvas.height)
      releases.push(() => F.CubismRenderer_WebGL.doStaticRelease())
      releases.push(() => result.release())
      result.initialize(model)
      result.startUp(gl)
      result.setIsPremultipliedAlpha(true)
      result.setMvpMatrix(new F.CubismMatrix44())
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      for (let index = 0; index < setting.getTextureCount(); index++) {
        const image = new Image()
        image.src = `model/${setting.getTextureFileName(index)}`
        await image.decode()
        const texture = gl.createTexture()
        if (!texture) throw new Error('texture allocation failed')
        releases.push(() => gl.deleteTexture(texture))
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          image,
        )
        gl.texParameteri(
          gl.TEXTURE_2D,
          gl.TEXTURE_MIN_FILTER,
          gl.LINEAR_MIPMAP_LINEAR,
        )
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.generateMipmap(gl.TEXTURE_2D)
        result.bindTexture(index, texture)
        state.textureCount++
      }
      if (state.textureCount === 0) throw new Error('no textures')
      result.loadShaders('shaders/') // 5-r.5 loads shader files asynchronously.
      return result
    })
    state.steps['textures-bound'].value = `textures=${state.textureCount}`
    const motion = await step('motion-loaded', async () => {
      const buffer = await fetchBuf(
        `model/${setting.getMotionFileName('Idle', 0)}`,
      )
      const result = F.CubismMotion.create(
        buffer,
        buffer.byteLength,
        undefined,
        undefined,
        true,
      )
      if (result === null)
        throw new Error('idle motion failed consistency check')
      releases.push(() => result.release())
      result.setLoop(true)
      const collect = (count, getId) =>
        Array.from({ length: count }, (_, index) => getId(index))
      result.setEffectIds(
        collect(setting.getEyeBlinkParameterCount(), (index) =>
          setting.getEyeBlinkParameterId(index),
        ),
        collect(setting.getLipSyncParameterCount(), (index) =>
          setting.getLipSyncParameterId(index),
        ),
      )
      return result
    })
    state.steps['motion-loaded'].value = 'official Idle motion parsed'
    await step('animated-render', async () => {
      const draw = () => {
        model.update()
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        renderer.setRenderState(null, [0, 0, canvas.width, canvas.height])
        renderer.drawModel('shaders/')
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
        if (gl.getError() !== gl.NO_ERROR)
          throw new Error('WebGL draw/readback error')
        let hash = 2166136261,
          visible = 0
        for (let index = 0; index < pixels.length; index++) {
          hash = Math.imul(hash ^ pixels[index], 16777619) >>> 0
          if (index % 4 === 3 && pixels[index] !== 0) visible++
        }
        return { hash, visible }
      }
      // Wait for actual nonempty drawing, not an assumed shader-load delay.
      const deadline = performance.now() + 10000
      while (draw().visible === 0) {
        if (state.error) throw new Error(state.error)
        if (performance.now() >= deadline)
          throw new Error('shader/model never produced visible pixels')
        await wait(50)
      }
      const manager = new F.CubismMotionManager()
      releases.push(() => manager.release())
      // Signature: (motion, autoDelete:boolean, priority). We own motion cleanup.
      if (manager.startMotionPriority(motion, false, 3) === -1)
        throw new Error('motion did not start')
      for (const deltaSeconds of [1 / 60, 0.12, 0.24]) {
        model.loadParameters()
        const updated = manager.updateMotion(model, deltaSeconds)
        state.motionUpdated.push(updated)
        if (updated !== true)
          throw new Error('motion manager reported no parameter update')
        const values = Array.from({ length: state.paramCount }, (_, index) => {
          const value = model.getParameterValueByIndex(index)
          const min = model.getParameterMinimumValue(index),
            max = model.getParameterMaximumValue(index)
          if (
            !Number.isFinite(value) ||
            !Number.isFinite(min) ||
            !Number.isFinite(max) ||
            value < min - 1e-5 ||
            value > max + 1e-5
          )
            throw new Error(
              'motion produced a nonfinite or out-of-range parameter',
            )
          return value
        })
        state.parameterFrames.push(values)
        model.saveParameters()
        const frame = draw()
        if (frame.visible === 0)
          throw new Error('motion frame contains no visible pixels')
        state.frames.push(frame.hash)
        state.nonTransparentPixels.push(frame.visible)
        await wait(16)
      }
      if (
        !state.parameterFrames[0].some(
          (value, index) =>
            Math.abs(value - state.parameterFrames[2][index]) > 1e-6,
        )
      )
        throw new Error('motion did not change any real model parameter')
      if (state.frames[0] === state.frames[2])
        throw new Error('motion frames have identical pixel hashes')
      return { hashes: state.frames, visiblePixels: state.nonTransparentPixels }
    })
  } catch (error) {
    state.error ??= `verification: ${describe(error)}`
  } finally {
    for (const release of releases.reverse()) {
      try {
        release()
      } catch (error) {
        state.cleanupErrors.push(describe(error))
      }
    }
    state.resourcesReleased = state.cleanupErrors.length === 0
    if (!state.resourcesReleased) state.error ??= 'resource cleanup failed'
    window.removeEventListener('unhandledrejection', rejectAsync)
    state.done = true
  }
})()

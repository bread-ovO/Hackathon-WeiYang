// PET01 harness: verifies official Cubism SDK for Web inside an Electron
// renderer with the production security posture (sandbox, contextIsolation,
// strict CSP). Runs only on test assets under .pet-sdk/ (never committed).
;(async () => {
  const F = window.Live2DCubismFramework
  const state = window.__petVerify = {
    steps: {},
    wasmAllowed: null,
    coreVersion: null,
    modelLoaded: false,
    paramCount: 0,
    drawableCount: 0,
    textureCount: 0,
    frames: [],
    negativeMoc3Error: null,
    error: null,
    done: false,
  }
  const step = async (name, fn) => {
    try {
      state.steps[name] = { ok: true, value: await fn() }
    } catch (e) {
      state.steps[name] = { ok: false, error: String((e && e.message) || e) }
      state.error = `${name}: ${state.steps[name].error}`
      throw e
    }
  }

  try {
    await step('wasm-probe', async () => {
      try {
        await WebAssembly.compile(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]))
        state.wasmAllowed = true
      } catch {
        state.wasmAllowed = false
      }
      return state.wasmAllowed
    })
    await step('core-loaded', async () => {
      if (!window.Live2DCubismCore) throw new Error('Live2DCubismCore global missing')
      return true
    })
    await step('core-version', async () => {
      const v = window.Live2DCubismCore.Version.csmGetVersion() >>> 0
      state.coreVersion = `${v >>> 24}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255} (0x${v.toString(16)})`
      return state.coreVersion
    })
    await step('framework-init', async () => {
      F.CubismFramework.startUp()
      F.CubismFramework.initialize()
      return true
    })

    const fetchBuf = url => fetch(url).then(r => {
      if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`)
      return r.arrayBuffer()
    })

    const settingJson = await step('model-setting', async () => {
      const buf = await fetchBuf('model/Haru.model3.json')
      window.__setting = new F.CubismModelSettingJson(buf)
      return 'model3.json parsed'
    })

    const canvas = document.getElementById('stage')
    canvas.width = 512
    canvas.height = 512
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true })
    if (!gl) throw new Error('WebGL context unavailable')

    await step('moc-load', async () => {
      // The consistency check is the same official gate PET03 import uses.
      const moc = F.CubismMoc.create(await fetchBuf('model/Haru.moc3'), true)
      if (!moc) throw new Error('Haru.moc3 failed the framework consistency check')
      const model = moc.createModel()
      model.initialize()
      state.paramCount = model.getParameterCount?.() ?? -1
      state.drawableCount = model.getDrawableCount?.() ?? -1
      state.modelLoaded = true
      window.__model = model
      return `params=${state.paramCount} drawables=${state.drawableCount}`
    })

    await step('bad-moc-rejected', async () => {
      const garbage = new Uint8Array(64).fill(0x23)
      const moc = F.CubismMoc.create(garbage.buffer, true)
      if (moc !== null) throw new Error('framework accepted an invalid moc3')
      const coreMoc = window.Live2DCubismCore.Moc.fromArrayBuffer(garbage.buffer)
      state.negativeMoc3Error = `framework=null, core=${coreMoc === null ? 'null' : 'ACCEPTED GARBAGE'}`
      return state.negativeMoc3Error
    })

    await step('textures-bound', async () => {
      const renderer = new F.CubismRenderer_WebGL(canvas.width, canvas.height)
      window.__renderer = renderer
      renderer.initialize(window.__model)
      renderer.startUp(gl)
      renderer.loadShaders('shaders/')
      renderer.setIsPremultipliedAlpha(true)
      const setting = window.__setting
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      const textureCount = setting.getTextureCount()
      for (let i = 0; i < textureCount; i++) {
        const image = new Image()
        image.src = `model/${setting.getTextureFileName(i)}`
        await image.decode()
        const texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.generateMipmap(gl.TEXTURE_2D)
        renderer.bindTexture(i, texture)
      }
      state.textureCount = textureCount
      return `textures=${textureCount}`
    })

    await step('motion-loaded', async () => {
      const buf = await fetchBuf('model/motions/haru_g_idle.motion3.json')
      const motion = F.CubismMotion.create(buf, buf.byteLength)
      if (!motion) throw new Error('CubismMotion.create returned null for the idle motion')
      motion.setLoop?.(true)
      // Required by doUpdateParameters; ids come from the model3.json groups.
      const setting = window.__setting
      const collect = (count, id) => {
        const ids = []
        for (let i = 0; i < count; i++) ids.push(id(i))
        return ids
      }
      motion.setEffectIds(
        collect(setting.getEyeBlinkParameterCount?.() ?? 0, i => setting.getEyeBlinkParameterId(i)),
        collect(setting.getLipSyncParameterCount?.() ?? 0, i => setting.getLipSyncParameterId(i)),
      )
      window.__motion = motion
      return 'idle motion parsed'
    })

    await step('animated-render', async () => {
      const renderer = window.__renderer
      const model = window.__model
      // CubismMotionManager is the single-motion driver the official demo uses.
      const motionManager = new F.CubismMotionManager()
      motionManager.startMotionPriority?.(window.__motion, performance.now() / 1000, 3)
      window.__motionManager = motionManager
      const readHash = () => {
        const pixels = new Uint8Array(canvas.width * canvas.height * 4)
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let hash = 0
        for (let i = 0; i < pixels.length; i += 97) hash = (hash * 31 + pixels[i]) | 0
        return hash
      }
      const renderOnce = () => {
        const t = performance.now() / 1000
        model.setParameterValueById?.('ParamBreath', (Math.sin(t * 2) + 1) / 2)
        const motionUpdated = motionManager.updateMotion?.(model, t)
        if (motionUpdated === undefined && !motionManager.updateMotion) {
          throw new Error('motion manager cannot drive the model')
        }
        model.update()
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        renderer.setRenderState?.(null, [0, 0, canvas.width, canvas.height])
        renderer.drawModel('shaders/')
      }
      renderOnce()
      state.frames.push(readHash())
      await new Promise(resolve => setTimeout(resolve, 120))
      renderOnce()
      state.frames.push(readHash())
      await new Promise(resolve => setTimeout(resolve, 240))
      renderOnce()
      state.frames.push(readHash())
      if (state.frames[0] === 0 && state.frames[2] === 0) throw new Error('canvas stayed empty')
      if (state.frames[0] === state.frames[2]) throw new Error('render is static, no animation detected')
      return state.frames.join(',')
    })
    state.done = true
  } catch {
    // state.error already records the failing step; the spec asserts on state.
  }
})()

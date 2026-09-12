import { describe, expect, it } from 'vitest'
import { guardShaderRegistration } from '../../apps/desktop/src/renderer/src/pet-shader-lifecycle'
class DeferredShader {
  allocations = 0
  registerShader() { this.allocations += 4 }
  registerBlendShader() { this.allocations += 2 }
  async load(pending: Promise<void>) {
    await pending
    this.registerShader()
    this.registerBlendShader()
  }
}
describe('Cubism shader session registration gate', () => {
  it('allows active shader registration with the original this binding', async () => {
    const shader = new DeferredShader();guardShaderRegistration(shader)
    await shader.load(Promise.resolve())
    expect(shader.allocations).toBe(6)
  })
  it('blocks both late async GPU registration entries after disposal', async () => {
    let settle!: () => void
    const pending = new Promise<void>(resolve => { settle = resolve })
    const shader = new DeferredShader(), dispose = guardShaderRegistration(shader)
    const loading = shader.load(pending)
    dispose();dispose();settle();await loading
    expect(shader.allocations).toBe(0)
  })
  it('does not poison the fresh shader instance for the same restored context', async () => {
    let settle!: () => void
    const old = new DeferredShader(), close = guardShaderRegistration(old)
    const loading = old.load(new Promise<void>(resolve => { settle = resolve }))
    close()
    // SDK staticRelease clears the manager map; startUp registers a new instance.
    const replacement = new DeferredShader();guardShaderRegistration(replacement)
    await replacement.load(Promise.resolve());settle();await loading
    expect(old.allocations).toBe(0);expect(replacement.allocations).toBe(6)
  })
})

export interface ShaderRegistration {
  registerShader(): void
  registerBlendShader(): void
}
/** The pinned SDK's asynchronous loader calls both public registration methods
 * after fetch settles. Close this per-instance gate BEFORE SDK release so a late
 * callback cannot allocate programs in an old (possibly restored) GL context. */
export function guardShaderRegistration(
  shader: ShaderRegistration,
): () => void {
  let live = true
  const regular = shader.registerShader.bind(shader)
  const blend = shader.registerBlendShader.bind(shader)
  shader.registerShader = () => {
    if (live) regular()
  }
  shader.registerBlendShader = () => {
    if (live) blend()
  }
  return () => {
    live = false
  }
}

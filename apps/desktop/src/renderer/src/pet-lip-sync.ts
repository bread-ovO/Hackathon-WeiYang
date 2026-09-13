interface LipParameterModel {
  getParameterCount(): number
  getParameterId(index: number): object
  getParameterValueByIndex(index: number): number
  getParameterMinimumValue(index: number): number
  getParameterMaximumValue(index: number): number
  setParameterValueByIndex(index: number, value: number): void
}
/** Match only IDs declared by the model's LipSync group to real core indexes.
 * Cubism can manufacture indexes for unknown IDs; do not call that lookup. */
export function createDeclaredLipSync(
  model: LipParameterModel,
  declared: readonly object[],
) {
  const parameters: { index: number; min: number; max: number }[] = []
  const count = model.getParameterCount()
  if (Number.isSafeInteger(count) && count >= 0 && count <= 100000) {
    for (let index = 0; index < count; index++) {
      if (!declared.includes(model.getParameterId(index))) continue
      const min = model.getParameterMinimumValue(index),
        max = model.getParameterMaximumValue(index)
      if (Number.isFinite(min) && Number.isFinite(max) && min < max)
        parameters.push({ index, min, max })
    }
  }
  let level: number | null = null
  let appliedFrames = 0
  return {
    available: parameters.length > 0,
    set(value: number | null) {
      level =
        value !== null && Number.isFinite(value)
          ? Math.max(0, Math.min(1, value))
          : null
    },
    apply() {
      if (level === null) return
      for (const p of parameters)
        model.setParameterValueByIndex(p.index, p.min + (p.max - p.min) * level)
      if (parameters.length) appliedFrames++
    },
    state() {
      return {
        appliedFrames,
        parameters: parameters.map((p) => ({
          index: p.index,
          value: model.getParameterValueByIndex(p.index),
        })),
      }
    },
  }
}

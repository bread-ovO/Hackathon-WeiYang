/** Cubism parameter IDs and indexes are immutable for a model's lifetime.
 * Cache native IDs only; unknown IDs still use Cubism's virtual-parameter logic.
 */
export function cachePetParameterIndexes<T extends object>(model: {
  getParameterCount(): number
  getParameterId(index: number): T
  getParameterIndex(id: T): number
}) {
  const indexes = new Map<T, number>()
  for (let i = 0; i < model.getParameterCount(); i++)
    indexes.set(model.getParameterId(i), i)
  const original = model.getParameterIndex
  model.getParameterIndex = function (id) {
    return indexes.get(id) ?? original.call(this, id)
  }
}

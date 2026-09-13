export interface PetActionOption {
  id: string
  label: string
}
export interface PetActionCatalog {
  motions: PetActionOption[]
  expressions: PetActionOption[]
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const invalid = (): never => {
  throw new Error('INVALID_PET_ACTIONS')
}
const label = (v: string) =>
  v
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, 96)
/** Index-based identifiers are shared by the trusted host catalog and renderer.
 * Only display labels leave this boundary; resource paths never enter a play request. */
export function parsePetActionCatalog(input: unknown): PetActionCatalog {
  if (!record(input)) return invalid()
  const result: PetActionCatalog = { motions: [], expressions: [] }
  if (input.FileReferences === undefined) return result
  if (!record(input.FileReferences)) return invalid()
  const refs = input.FileReferences
  if (refs.Motions !== undefined) {
    if (!record(refs.Motions) || Object.keys(refs.Motions).length > 64)
      return invalid()
    Object.entries(refs.Motions).forEach(([group, entries], groupIndex) => {
      if (!Array.isArray(entries) || entries.length > 64) return invalid()
      entries.forEach((entry, index) => {
        if (
          !record(entry) ||
          typeof entry.File !== 'string' ||
          !entry.File ||
          result.motions.length >= 64
        )
          return invalid()
        result.motions.push({
          id: `motion:${groupIndex}:${index}`,
          label: `${label(group) || '动作'} ${index + 1}`,
        })
      })
    })
  }
  if (refs.Expressions !== undefined) {
    if (!Array.isArray(refs.Expressions) || refs.Expressions.length > 64)
      return invalid()
    refs.Expressions.forEach((entry, index) => {
      if (
        !record(entry) ||
        typeof entry.File !== 'string' ||
        !entry.File ||
        typeof entry.Name !== 'string'
      )
        return invalid()
      result.expressions.push({
        id: `expression:${index}`,
        label: label(entry.Name) || `表情 ${index + 1}`,
      })
    })
  }
  return result
}
export interface PetPresentation {
  reference?: { label: string; reason: string }
  id: string
  kind: 'action' | 'bubble'
  text?: string
  actionId?: string
}

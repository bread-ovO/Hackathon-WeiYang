import { join, resolve, sep } from 'node:path'

const modelIdPattern = /^[a-f0-9]{64}$/u
const safeSegment = (value: string) =>
  value.length > 0 &&
  value.length <= 1024 &&
  !/[\\:%?#\x00-\x1f\x7f]/u.test(value) &&
  !value.split('/').some((part) => part === '' || part === '.' || part === '..')

/** PET06: map a `memo://app/models/<id>/<resource>` path into the controlled
 * model store. Anything ambiguous resolves to null — never a fallback. */
export function resolveModelResource(
  pathname: string,
  storeRoot: string,
): string | null {
  if (!pathname.startsWith('/models/')) return null
  const rest = pathname.slice('/models/'.length)
  const separator = rest.indexOf('/')
  if (separator < 0) return null
  const modelId = rest.slice(0, separator)
  const resource = rest.slice(separator + 1)
  if (!modelIdPattern.test(modelId) || !safeSegment(resource)) return null
  const target = resolve(join(storeRoot, modelId, resource))
  const root = resolve(storeRoot)
  // Belt and braces: the segments are already constrained, but keep the
  // prefix check so future refactors cannot silently widen it.
  if (!target.startsWith(root + sep)) return null
  return target
}

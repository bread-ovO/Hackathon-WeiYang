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

import { readPinnedPetFile } from './runtime-store'
import type { PetResource } from './runtime-store'
import { extname } from 'node:path'
export interface ModelResourceDescriptor {
  id: string
  entry: string
  resources: { path: string; bytes: number; sha256: string; kind: string }[]
}
const modelMime: Record<string, string> = {
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
}
/** Only pinned resources of the worker-selected model may be read. Never serve executable assets. */
export async function readModelResource(
  root: string,
  descriptor: ModelResourceDescriptor,
  relativePath: string,
): Promise<PetResource | null> {
  try {
    const model = structuredClone(descriptor)
    if (
      !model ||
      !modelIdPattern.test(model.id) ||
      !safeSegment(model.entry) ||
      !model.entry.endsWith('.model3.json') ||
      !Array.isArray(model.resources) ||
      !model.resources.length ||
      model.resources.length > 256 ||
      typeof relativePath !== 'string' ||
      !safeSegment(relativePath)
    )
      return null
    const mime = modelMime[extname(relativePath).toLowerCase()]
    if (!mime) return null
    if (
      new Set(model.resources.map((r) => r.path)).size !==
        model.resources.length ||
      model.resources.some(
        (r) =>
          !r ||
          !safeSegment(r.path) ||
          !Number.isSafeInteger(r.bytes) ||
          r.bytes <= 0 ||
          r.bytes > 32 * 1024 * 1024 ||
          typeof r.sha256 !== 'string' ||
          !modelIdPattern.test(r.sha256) ||
          typeof r.kind !== 'string' ||
          r.kind.length > 32,
      ) ||
      model.resources.reduce((n, r) => n + r.bytes, 0) > 128 * 1024 * 1024
    )
      return null
    const resource = model.resources.find((r) => r.path === relativePath)
    if (!resource) return null
    return {
      bytes: await readPinnedPetFile(
        join(resolve(root), model.id),
        relativePath,
        resource.bytes,
        resource.sha256,
      ),
      mime,
    }
  } catch {
    return null
  }
}

export interface PetVoicePcm {
  sampleRate: number
  channels: 1
  format: 'f32le'
  frames: number
  data: string
}
/** Shared browser/host boundary; no Node, filesystem or audio playback capability. */
export function parsePetVoicePcm(value: unknown): PetVoicePcm {
  const invalid = (): never => {
    throw Error('PET_VOICE_INVALID_PCM')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid()
  const v = value as Record<string, unknown>
  if (
    Object.keys(v).sort().join(',') !==
      'channels,data,format,frames,sampleRate' ||
    !Number.isSafeInteger(v.sampleRate) ||
    Number(v.sampleRate) < 8000 ||
    Number(v.sampleRate) > 48000 ||
    v.channels !== 1 ||
    v.format !== 'f32le' ||
    !Number.isSafeInteger(v.frames) ||
    Number(v.frames) < 1 ||
    Number(v.frames) > Number(v.sampleRate) * 12 ||
    typeof v.data !== 'string'
  )
    return invalid()
  const size = Number(v.frames) * 4
  if (
    v.data.length !== Math.ceil(size / 3) * 4 ||
    v.data.length > 3072000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data)
  )
    return invalid()
  let binary: string
  try {
    binary = atob(v.data)
    if (binary.length !== size || btoa(binary) !== v.data) return invalid()
  } catch {
    return invalid()
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0)),
    view = new DataView(bytes.buffer)
  for (let i = 0; i < size; i += 4) {
    const sample = view.getFloat32(i, true)
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) return invalid()
  }
  return {
    sampleRate: Number(v.sampleRate),
    channels: 1,
    format: 'f32le',
    frames: Number(v.frames),
    data: v.data,
  }
}

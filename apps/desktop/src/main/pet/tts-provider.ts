import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { isAbsolute } from 'node:path'
import { parsePetVoicePcm, type PetVoicePcm } from '@memo/contracts'
export interface SystemVoiceOption {
  id: string
  name: string
  language: string
}
export type TtsSpawn = (
  file: string,
  args: string[],
  options: { stdio: 'pipe' },
) => ChildProcessWithoutNullStreams
const errors = new Set([
  'PET_VOICE_UNAVAILABLE',
  'PET_VOICE_INVALID',
  'PET_VOICE_INVALID_PCM',
  'PET_VOICE_TOO_LONG',
  'PET_VOICE_TIMEOUT',
  'PET_VOICE_CANCELLED',
  'PET_VOICE_BUSY',
])
function fail(code: string): never {
  throw Error(errors.has(code) ? code : 'PET_VOICE_UNAVAILABLE')
}
function field(v: unknown, max = 256): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(v)
  )
}
/** Helper never receives paths from renderer; one bounded JSON subprocess, no shell. */
export function createSystemTtsProvider(options: {
  helperPath: string
  platform?: string
  spawn?: TtsSpawn
}) {
  const helperPath = options.helperPath,
    platform = options.platform ?? process.platform,
    spawn = options.spawn ?? nodeSpawn
  let busy = false
  async function run(
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!signal || typeof signal.addEventListener !== 'function')
      fail('PET_VOICE_INVALID')
    if (signal.aborted) fail('PET_VOICE_CANCELLED')
    if (
      platform !== 'darwin' ||
      !isAbsolute(helperPath) ||
      helperPath.includes('\0')
    )
      fail('PET_VOICE_UNAVAILABLE')
    if (busy) fail('PET_VOICE_BUSY')
    const body = JSON.stringify(input)
    if (Buffer.byteLength(body) > 8192) fail('PET_VOICE_INVALID')
    busy = true
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        let child: ChildProcessWithoutNullStreams | undefined,
          settled = false,
          size = 0,
          stderrSize = 0
        const chunks: Buffer[] = []
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
        const end = (code: string) => {
          if (settled) return
          settled = true
          cleanup()
          child?.kill('SIGKILL')
          reject(Error(errors.has(code) ? code : 'PET_VOICE_UNAVAILABLE'))
        }
        const abort = () => end('PET_VOICE_CANCELLED'),
          timer = setTimeout(() => end('PET_VOICE_TIMEOUT'), 20000)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
        try {
          child = spawn(helperPath, [], { stdio: 'pipe' })
          child.on('error', () => end('PET_VOICE_UNAVAILABLE'))
          child.stdin.on('error', () => end('PET_VOICE_UNAVAILABLE'))
          child.stdout.on('error', () => end('PET_VOICE_UNAVAILABLE'))
          child.stderr.on('error', () => end('PET_VOICE_UNAVAILABLE'))
          child.stdout.on('data', (chunk: unknown) => {
            if (settled) return
            if (!(chunk instanceof Uint8Array)) {
              end('PET_VOICE_INVALID')
              return
            }
            size += chunk.byteLength
            if (size > 3100000) {
              end('PET_VOICE_TOO_LONG')
              return
            }
            chunks.push(Buffer.from(chunk))
          })
          child.stderr.on('data', (chunk: unknown) => {
            stderrSize += chunk instanceof Uint8Array ? chunk.byteLength : 65537
            if (stderrSize > 65536) end('PET_VOICE_UNAVAILABLE')
          })
          child.on('close', (code: number | null) => {
            if (settled) return
            if (signal.aborted) {
              abort()
              return
            }
            if (code !== 0) {
              end('PET_VOICE_UNAVAILABLE')
              return
            }
            try {
              const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                  Buffer.concat(chunks),
                ),
              )
              if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                throw Error()
              const result = raw as Record<string, unknown>
              if (result.ok !== true) {
                if (
                  Object.keys(result).sort().join(',') === 'error,ok' &&
                  result.ok === false &&
                  typeof result.error === 'string'
                ) {
                  end(result.error)
                  return
                }
                throw Error()
              }
              settled = true
              cleanup()
              resolve(result)
            } catch {
              end('PET_VOICE_INVALID')
            }
          })
          child.stdin.end(body)
        } catch {
          end('PET_VOICE_UNAVAILABLE')
        }
      })
    } finally {
      busy = false
    }
  }
  return {
    async voices(signal: AbortSignal): Promise<SystemVoiceOption[]> {
      const r = await run({ method: 'voices' }, signal)
      if (signal.aborted) fail('PET_VOICE_CANCELLED')
      if (
        Object.keys(r).sort().join(',') !== 'ok,voices' ||
        !Array.isArray(r.voices) ||
        r.voices.length > 512
      )
        fail('PET_VOICE_INVALID')
      const seen = new Set<string>()
      return r.voices.map((v) => {
        if (
          !v ||
          typeof v !== 'object' ||
          Array.isArray(v) ||
          Object.keys(v).sort().join(',') !== 'id,language,name' ||
          !field(v.id) ||
          !field(v.name) ||
          !field(v.language, 64) ||
          seen.has(v.id)
        )
          fail('PET_VOICE_INVALID')
        seen.add(v.id)
        return { id: v.id, name: v.name, language: v.language }
      })
    },
    async synthesize(input: {
      text: string
      voiceId: string
      rate: number
      signal: AbortSignal
    }): Promise<PetVoicePcm> {
      const { text, voiceId, rate, signal } = input
      if (
        !field(text, 2048) ||
        Array.from(text).length > 240 ||
        !text.trim() ||
        !field(voiceId) ||
        !Number.isFinite(rate) ||
        rate < 0.75 ||
        rate > 1.25
      )
        fail('PET_VOICE_INVALID')
      const r = await run({ method: 'synthesize', text, voiceId, rate }, signal)
      if (signal.aborted) fail('PET_VOICE_CANCELLED')
      if (Object.keys(r).sort().join(',') !== 'ok,pcm')
        fail('PET_VOICE_INVALID')
      return parsePetVoicePcm(r.pcm)
    },
  }
}

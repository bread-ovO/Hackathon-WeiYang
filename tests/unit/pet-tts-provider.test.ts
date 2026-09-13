import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  createSystemTtsProvider,
  type TtsSpawn,
} from '../../apps/desktop/src/main/pet/tts-provider'
import { parsePetVoicePcm } from '../../packages/contracts/src/pet-voice-pcm'
const pcm = (values = [0, 0.5, -0.5]) => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((v, i) => bytes.writeFloatLE(v, i * 4))
  return {
    sampleRate: 8000,
    channels: 1,
    format: 'f32le',
    frames: values.length,
    data: bytes.toString('base64'),
  }
}
function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  let input = ''
  child.stdin.on('data', (b) => {
    input += String(b)
  })
  const spawn = vi.fn(
    () => child as unknown as ChildProcessWithoutNullStreams,
  ) as ReturnType<typeof vi.fn> & TtsSpawn
  return {
    child,
    spawn,
    get input() {
      return input
    },
    reply(v: unknown) {
      child.stdout.write(JSON.stringify(v))
      child.emit('close', 0)
    },
  }
}
const opts = (spawn: TtsSpawn) => ({
  helperPath: '/private/synthetic/pet-tts',
  platform: 'darwin',
  spawn,
})
const synthesis = () => ({
  text: '合成测试',
  voiceId: 'installed-voice',
  rate: 1,
  signal: new AbortController().signal,
})
afterEach(() => vi.useRealTimers())
describe('system TTS subprocess boundary', () => {
  it('sends JSON stdin without shell args and projects available voices', async () => {
    const f = childFixture(),
      p = createSystemTtsProvider(opts(f.spawn)).voices(
        new AbortController().signal,
      )
    expect(f.spawn).toHaveBeenCalledWith('/private/synthetic/pet-tts', [], {
      stdio: 'pipe',
    })
    expect(JSON.parse(f.input)).toEqual({ method: 'voices' })
    f.reply({
      ok: true,
      voices: [{ id: 'v', name: '本机音色', language: 'zh-CN' }],
    })
    await expect(p).resolves.toEqual([
      { id: 'v', name: '本机音色', language: 'zh-CN' },
    ])
  })
  it('validates real PCM and does not treat text as command arguments', async () => {
    const f = childFixture(),
      p = createSystemTtsProvider(opts(f.spawn)).synthesize({
        ...synthesis(),
        text: '$(echo secret); "不是命令"',
      })
    expect(f.spawn.mock.calls[0]![1]).toEqual([])
    expect(JSON.parse(f.input).text).toContain('$(echo')
    f.reply({ ok: true, pcm: pcm() })
    await expect(p).resolves.toEqual(pcm())
  })
  it('rejects nonmacOS and missing/relative helper before spawning', async () => {
    const f = childFixture()
    for (const patch of [{ platform: 'linux' }, { helperPath: 'relative' }])
      await expect(
        createSystemTtsProvider({ ...opts(f.spawn), ...patch }).voices(
          new AbortController().signal,
        ),
      ).rejects.toThrow('PET_VOICE_UNAVAILABLE')
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it('cancels before spawn or kills pending synthesis, ignores late success', async () => {
    const f = childFixture(),
      provider = createSystemTtsProvider(opts(f.spawn)),
      c = new AbortController()
    c.abort()
    await expect(provider.voices(c.signal)).rejects.toThrow(
      'PET_VOICE_CANCELLED',
    )
    expect(f.spawn).not.toHaveBeenCalled()
    const d = new AbortController(),
      p = provider.synthesize({ ...synthesis(), signal: d.signal })
    const rejected = expect(p).rejects.toThrow('PET_VOICE_CANCELLED')
    d.abort()
    await rejected
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL')
    f.reply({ ok: true, pcm: pcm() })
  })
  it('cancel after native close still rejects a result before continuation', async () => {
    const f = childFixture(),
      c = new AbortController(),
      p = createSystemTtsProvider(opts(f.spawn)).synthesize({
        ...synthesis(),
        signal: c.signal,
      })
    f.reply({ ok: true, pcm: pcm() })
    c.abort()
    await expect(p).rejects.toThrow('PET_VOICE_CANCELLED')
  })
  it('caps stderr even though diagnostics are never returned', async () => {
    const f = childFixture(),
      p = createSystemTtsProvider(opts(f.spawn)).voices(
        new AbortController().signal,
      )
    f.child.stderr.write(Buffer.alloc(65537))
    await expect(p).rejects.toThrow('PET_VOICE_UNAVAILABLE')
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL')
  })
  it('limits concurrency and kills after 20 seconds', async () => {
    vi.useFakeTimers()
    const f = childFixture(),
      provider = createSystemTtsProvider(opts(f.spawn)),
      p = provider.voices(new AbortController().signal),
      rejected = expect(p).rejects.toThrow('PET_VOICE_TIMEOUT')
    await expect(provider.synthesize(synthesis())).rejects.toThrow(
      'PET_VOICE_BUSY',
    )
    await vi.advanceTimersByTimeAsync(20000)
    await rejected
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL')
  })
  it.each([
    { text: 'x'.repeat(241) },
    { voiceId: '' },
    { rate: NaN },
    { rate: 2 },
    { text: 'x\nprivate' },
  ])('rejects invalid request %j before spawn', async (patch) => {
    const f = childFixture()
    await expect(
      createSystemTtsProvider(opts(f.spawn)).synthesize({
        ...synthesis(),
        ...patch,
      }),
    ).rejects.toThrow('PET_VOICE_INVALID')
    expect(f.spawn).not.toHaveBeenCalled()
  })
  it.each([
    {
      ok: true,
      voices: [{ id: 'x', name: 'x', language: 'en', path: 'private' }],
    },
    {
      ok: true,
      voices: [
        { id: 'x', name: 'x', language: 'en' },
        { id: 'x', name: 'x', language: 'en' },
      ],
    },
    { ok: true, voices: [], secret: 'private' },
    { ok: false, error: 'private raw stderr' },
  ])('rejects or scrubs helper output %j', async (response) => {
    const f = childFixture(),
      p = createSystemTtsProvider(opts(f.spawn)).voices(
        new AbortController().signal,
      )
    f.reply(response)
    await expect(p).rejects.toThrow(/PET_VOICE_(INVALID|UNAVAILABLE)/)
  })
  it('forwards only fixed provider failure and never stderr', async () => {
    const f = childFixture(),
      p = createSystemTtsProvider(opts(f.spawn)).synthesize(synthesis())
    f.child.stderr.write('private diagnostics')
    f.reply({ ok: false, error: 'PET_VOICE_TOO_LONG' })
    await expect(p).rejects.toThrow('PET_VOICE_TOO_LONG')
  })
  it('rejects multiple JSON, invalid UTF8, excess stdout and nonzero exit', async () => {
    for (const mode of ['double', 'utf8', 'size', 'exit']) {
      const f = childFixture(),
        p = createSystemTtsProvider(opts(f.spawn)).voices(
          new AbortController().signal,
        )
      f.child.stdout.write(
        mode === 'double'
          ? '{}{}'
          : mode === 'utf8'
            ? Buffer.from([255])
            : mode === 'size'
              ? Buffer.alloc(3100001)
              : '{}',
      )
      f.child.emit('close', mode === 'exit' ? 1 : 0)
      await expect(p).rejects.toThrow(
        /PET_VOICE_(INVALID|UNAVAILABLE|TOO_LONG)/,
      )
    }
  })
})
describe('shared PCM schema', () => {
  it('accepts canonical little endian float samples and exact12second capacity', () => {
    expect(parsePetVoicePcm(pcm())).toEqual(pcm())
    const max = {
      sampleRate: 48000,
      channels: 1,
      format: 'f32le',
      frames: 576000,
      data: Buffer.alloc(2304000).toString('base64'),
    }
    expect(parsePetVoicePcm(max).frames).toBe(576000)
  })
  it.each([NaN, Infinity, -Infinity, 1.1, -1.1])(
    'rejects unsafe sample %s',
    (value) =>
      expect(() => parsePetVoicePcm(pcm([value]))).toThrow(
        'PET_VOICE_INVALID_PCM',
      ),
  )
  it.each([
    { channels: 2 },
    { format: 's16le' },
    { frames: 0 },
    { frames: 96001 },
    { sampleRate: 7999 },
    { sampleRate: 48001 },
    { sampleRate: 8000.1 },
    { data: 'AAAAAB==' },
    { data: 'AAAAAA==\n' },
    { secret: 'extra' },
  ])('rejects malformed PCM %j', (patch) =>
    expect(() => parsePetVoicePcm({ ...pcm([0]), ...patch })).toThrow(
      'PET_VOICE_INVALID_PCM',
    ),
  )
})

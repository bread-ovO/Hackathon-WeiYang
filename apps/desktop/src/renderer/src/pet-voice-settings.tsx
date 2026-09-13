import { useEffect, useRef, useState } from 'react'
import { Checkbox } from '@cloudflare/kumo/components/checkbox'
import type { PetVoiceState, PetVoicePreferences } from '@memo/contracts'
import { AppButton, AppInput } from './ui'
const errors: Record<string, string> = {
  PET_VOICE_UNAVAILABLE: '系统声音暂不可用，桌宠仍显示文字。',
  PET_VOICE_INVALID: '请核对声音与音量设置。',
  PET_VOICE_INVALID_PCM: '声音数据不可用，已保留文字。',
  PET_VOICE_TOO_LONG: '这段话超过播音长度，已保留文字。',
  PET_VOICE_TIMEOUT: '系统声音生成超时，已保留文字。',
  PET_VOICE_CANCELLED: '已停止播音。',
  PET_VOICE_BUSY: '声音正在处理中，请稍后重试。',
  PET_VOICE_STORAGE: '设置保存失败，请重试。',
  PET_VOICE_CONFLICT: '设置已改变，请刷新后重试。',
}
export function PetVoiceSettings() {
  const [state, setState] = useState<PetVoiceState | null>(null),
    [draft, setDraft] = useState<Omit<PetVoicePreferences, 'version'>>({
      enabled: false,
      voiceId: null,
      volume: 0.6,
      rate: 1,
    }),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const live = useRef(false),
    inFlight = useRef(false),
    initialized = useRef(false),
    draftVersion = useRef(1)
  useEffect(() => {
    live.current = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const r = await window.memo.pet.voiceState()
        if (!live.current) return
        if (r.ok) {
          setState(r.data)
          if (!initialized.current) {
            initialized.current = true
            const { version: _, ...p } = r.data.preferences
            setDraft(p)
            draftVersion.current = r.data.preferences.version
          }
        } else setMessage(errors[r.error] ?? '声音设置暂不可用。')
      } catch {
        if (live.current) setMessage('本地核心暂不可用。')
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      live.current = false
      clearInterval(timer)
    }
  }, [])
  const saved = state
    ? {
        enabled: state.preferences.enabled,
        voiceId: state.preferences.voiceId,
        volume: state.preferences.volume,
        rate: state.preferences.rate,
      }
    : null
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(saved)
  async function save() {
    if (!state || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    try {
      const r = await window.memo.pet.configureVoice({
        expectedVersion: draftVersion.current,
        preferences: draft,
      })
      if (!live.current) return
      if (r.ok) {
        setState(r.data)
        draftVersion.current = r.data.preferences.version
        setMessage('声音设置已保存，从下一条话语生效。')
      } else setMessage(errors[r.error] ?? '声音设置保存失败。')
    } catch {
      if (live.current) setMessage('本地核心暂不可用。')
    } finally {
      inFlight.current = false
      if (live.current) setBusy(false)
    }
  }
  const active =
    state?.status === 'synthesizing' ||
    state?.status === 'ready' ||
    state?.status === 'playing'
  return (
    <section className="pet-voice-settings" aria-label="桌宠声音">
      <h2>桌宠声音</h2>
      <p>
        让桌宠用系统声音读出话语。默认关闭，选好声音后，从下一条话语开始播音。
      </p>
      <Checkbox
        label="允许桌宠播音"
        checked={draft.enabled}
        disabled={busy || !state || (!state.available && !draft.enabled)}
        onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
      />
      {!state?.available && (
        <p role="status">当前没有可用的系统声音，桌宠继续显示文字。</p>
      )}
      <div className="pet-voice-fields">
        <label>
          系统声音
          <select
            aria-label="系统声音"
            disabled={busy || !state?.available}
            value={draft.voiceId ?? ''}
            onChange={(e) =>
              setDraft({ ...draft, voiceId: e.target.value || null })
            }
          >
            <option value="">请选择系统声音</option>
            {state?.voices.map((v) => (
              <option value={v.id} key={v.id}>
                {v.name} · {v.language}
              </option>
            ))}
          </select>
        </label>
        <label>
          音量
          <AppInput
            aria-label="桌宠音量"
            type="number"
            min={0}
            max={1}
            step={0.1}
            value={draft.volume}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, volume: Number(e.target.value) })
            }
          />
        </label>
        <label>
          语速
          <AppInput
            aria-label="桌宠语速"
            type="number"
            min={0.75}
            max={1.25}
            step={0.05}
            value={draft.rate}
            disabled={busy}
            onChange={(e) =>
              setDraft({ ...draft, rate: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <div className="source-import-actions">
        <AppButton
          disabled={
            busy ||
            !state ||
            !dirty ||
            (draft.enabled &&
              !state.voices.some((v) => v.id === draft.voiceId)) ||
            !Number.isFinite(draft.volume) ||
            draft.volume < 0 ||
            draft.volume > 1 ||
            !Number.isFinite(draft.rate) ||
            draft.rate < 0.75 ||
            draft.rate > 1.25
          }
          onClick={() => void save()}
        >
          保存声音设置
        </AppButton>
        <AppButton
          disabled={!active}
          onClick={() =>
            void window.memo.pet
              .stopVoice()
              .then((r) => {
                if (!live.current) return
                if (r.ok) {
                  setState(r.data)
                  setMessage('已停止播音，文字继续保留。')
                } else setMessage(errors[r.error] ?? '停止失败，请重试。')
              })
              .catch(() => {
                if (live.current) setMessage('本地核心暂不可用。')
              })
          }
        >
          停止当前播音
        </AppButton>
      </div>
      <details>
        <summary>声音与数据范围</summary>
        <p>
          使用 macOS 已安装的系统声音，在本机合成当前气泡文字。每段最多 12
          秒，生成失败时保留文字；系统声音不可用的平台仅显示文字。
        </p>
      </details>
      {state?.error && (
        <p role="status">
          {errors[state.error] ?? '声音暂不可用，文字仍保留。'}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}

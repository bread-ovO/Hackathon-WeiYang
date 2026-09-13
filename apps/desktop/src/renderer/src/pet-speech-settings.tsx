import { useEffect, useState } from 'react'
import type { PetSpeechPatch, PetSpeechState } from '@memo/contracts'
import { AppButton } from './ui'
const time = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const minutes = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number)
  return hours! * 60 + minutes!
}
const statusText: Record<PetSpeechState['status'], string> = {
  disabled: '尚未开启',
  paused: '已暂停',
  quiet: '静默时段中',
  suppressed: '当前暂不打扰',
  waiting: '等待下一次话语',
  error: '自动话语暂不可用',
}
export function PetSpeechSettings({
  state,
  busy,
  onConfigure,
}: {
  state: PetSpeechState | undefined
  busy: boolean
  onConfigure(patch: PetSpeechPatch): Promise<void>
}) {
  const prefs = state?.preferences
  const start = prefs?.quietStart ?? 1320,
    end = prefs?.quietEnd ?? 540
  const [quietStart, setQuietStart] = useState(time(start)),
    [quietEnd, setQuietEnd] = useState(time(end))
  useEffect(() => {
    setQuietStart(time(start))
    setQuietEnd(time(end))
  }, [start, end])
  const disabled = busy || !state
  const dirty = quietStart !== time(start) || quietEnd !== time(end)
  const valid = /^\d\d:\d\d$/.test(quietStart) && /^\d\d:\d\d$/.test(quietEnd)
  const paused = (prefs?.pausedUntil ?? 0) > Date.now()
  return (
    <section className="pet-speech-settings" aria-label="自动话语设置">
      <div className="pet-speech-heading">
        <div>
          <h3>自动话语</h3>
          <p>开启后，桌宠偶尔显示一句文字气泡；没有声音，不会改变事项状态。</p>
        </div>
        <AppButton
          type="button"
          disabled={disabled}
          aria-pressed={prefs?.enabled ?? false}
          onClick={() => void onConfigure({ enabled: !prefs?.enabled })}
        >
          {prefs?.enabled ? '关闭自动话语' : '开启自动话语'}
        </AppButton>
      </div>
      <div className="pet-speech-fields">
        <label htmlFor="pet-speech-frequency">出现频率</label>
        <select
          id="pet-speech-frequency"
          disabled={disabled}
          value={prefs?.frequency ?? 'normal'}
          onChange={(event) =>
            void onConfigure({
              frequency: event.target.value as 'low' | 'normal',
            })
          }
        >
          <option value="normal">普通 · 45–90 分钟</option>
          <option value="low">较少 · 90–180 分钟</option>
        </select>
        <span className="pet-speech-note">
          每天最多 6 次，默认关闭。只有开启后才会自动显示。
        </span>
        <label htmlFor="pet-quiet-start">静默时段</label>
        <div className="pet-speech-time-range">
          <input
            id="pet-quiet-start"
            aria-label="静默开始时间"
            type="time"
            value={quietStart}
            disabled={disabled}
            onChange={(event) => setQuietStart(event.target.value)}
          />
          <span>至</span>
          <input
            aria-label="静默结束时间"
            type="time"
            value={quietEnd}
            disabled={disabled}
            onChange={(event) => setQuietEnd(event.target.value)}
          />
          <AppButton
            type="button"
            disabled={disabled || !dirty || !valid}
            onClick={() =>
              void onConfigure({
                quietStart: minutes(quietStart),
                quietEnd: minutes(quietEnd),
              })
            }
          >
            保存时段
          </AppButton>
        </div>
        <span className="pet-speech-note">
          使用本机时间，默认 22:00 至次日 09:00；起止时间相同表示全天静默。
        </span>
      </div>
      <div className="pet-speech-footer">
        <p role="status">
          {state ? statusText[state.status] : '正在读取自动话语设置'}
          {state ? ` · 今天 ${state.todayCount}/6 次` : ''}
          {state?.nextAt
            ? ` · 下次 ${new Date(state.nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
            : ''}
          {paused
            ? ` · 暂停至 ${new Date(prefs!.pausedUntil!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
            : ''}
        </p>
        <AppButton
          type="button"
          disabled={disabled || !prefs?.enabled}
          onClick={() =>
            void onConfigure({
              pausedUntil: paused ? null : Date.now() + 3600000,
            })
          }
        >
          {paused ? '恢复自动话语' : '暂停 1 小时'}
        </AppButton>
      </div>
    </section>
  )
}

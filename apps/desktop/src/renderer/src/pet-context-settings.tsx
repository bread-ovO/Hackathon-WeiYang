import { useEffect, useRef, useState } from 'react'
import type {
  PetContextConfig,
  PetContextState,
  PetContextPreview,
} from '@memo/contracts'
import { Switch } from '@cloudflare/kumo/components/switch'
import { Disclosure } from './ui/disclosure'
import { Checkbox } from '@cloudflare/kumo/components/checkbox'
import { AppButton, AppInput } from './ui'
export function PetContextSettings() {
  const [state, setState] = useState<PetContextState | null>(null),
    [draft, setDraft] = useState<Omit<PetContextConfig, 'version'>>({
      enabled: false,
      projectIds: [],
      useModel: false,
      model: '',
    }),
    [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [preview, setPreview] = useState<PetContextPreview | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const epoch = useRef(0),
    pending = useRef(false)
  useEffect(() => {
    const ticket = ++epoch.current
    void Promise.all([
      window.memo.pet.contextState(),
      window.memo.workspace.list(),
    ])
      .then(([s, p]) => {
        if (epoch.current !== ticket) return
        if (s.ok) {
          setState(s.data)
          const { version: _, ...config } = s.data.config
          setDraft(config)
        } else setMessage('事项话语设置暂不可用')
        if (p.ok) setProjects(p.data.projects)
      })
      .catch(() => {
        if (epoch.current === ticket) setMessage('本地核心暂不可用')
      })
    return () => {
      epoch.current++
    }
  }, [])
  async function run<T>(
    request: () => Promise<
      { ok: true; data: T } | { ok: false; error: string }
    >,
    accept: (data: T) => void,
  ) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    const ticket = epoch.current
    try {
      const r = await request()
      if (ticket !== epoch.current) return
      if (r.ok) accept(r.data)
      else
        setMessage(
          r.error === 'VERSION_CONFLICT' || r.error === 'PET_CONTEXT_CONFLICT'
            ? '设置版本已变化，请重新打开设置后核实。'
            : r.error === 'PET_MODEL_OFFLINE'
              ? '本地模型服务不可用，请确认 Ollama 已启动。'
              : ((
                  {
                    PET_MODEL_CANCELLED: '生成已取消，未显示新话语。',
                    PET_MODEL_TIMEOUT: '本地模型请求超时，请稍后重试。',
                    PET_CONTEXT_COOLDOWN: '请求间隔至少10秒，请稍后重试。',
                    PET_CONTEXT_BUDGET: '今天的模型请求预算已用完。',
                    PET_CONTEXT_EXPIRED: '预览或依据已过期，请重新生成。',
                    PET_CONTEXT_UNAVAILABLE:
                      '没有可用的授权事项依据，或桌宠尚未就绪。',
                  } as Record<string, string>
                )[r.error] ?? '操作未完成，请检查已保存范围与桌宠状态。'),
        )
    } catch {
      if (ticket === epoch.current) setMessage('服务暂不可用，请稍后重试。')
    } finally {
      if (ticket === epoch.current) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  const saved = state
    ? {
        enabled: state.config.enabled,
        projectIds: state.config.projectIds,
        useModel: state.config.useModel,
        model: state.config.model,
      }
    : null
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(saved)
  return (
    <section className="pet-context-settings" aria-label="基于事项的话语">
      <div className="setting-card-heading">
        <div>
          <h2>基于事项的话语</h2>
          <p>提醒你回顾所选项目中的事项。调整后保存生效。</p>
        </div>{' '}
        <Switch
          aria-label="允许基于事项生成话语"
          checked={draft.enabled}
          disabled={busy || !state}
          onCheckedChange={(checked) =>
            setDraft({ ...draft, enabled: checked })
          }
        />
      </div>
      <Disclosure title="项目与话语设置">
        {' '}
        <fieldset disabled={busy || !state}>
          <legend>允许使用的项目（最多 3 个）</legend>
          {projects.map((p) => (
            <Checkbox
              key={p.id}
              label={p.name}
              checked={draft.projectIds.includes(p.id)}
              onCheckedChange={(checked) =>
                setDraft({
                  ...draft,
                  projectIds: checked
                    ? [...draft.projectIds, p.id].slice(0, 3)
                    : draft.projectIds.filter((id) => id !== p.id),
                })
              }
              disabled={
                busy ||
                !state ||
                (!draft.projectIds.includes(p.id) &&
                  draft.projectIds.length >= 3)
              }
            />
          ))}
          {!projects.length && <p>先在我的工作区创建项目并收录有效事项。</p>}
        </fieldset>
        <Checkbox
          label="使用本地模型选择话术"
          checked={draft.useModel}
          disabled={busy || !state}
          onCheckedChange={(checked) =>
            setDraft({ ...draft, useModel: checked })
          }
        />
        {draft.useModel && (
          <label>
            本地模型名称
            <AppInput
              aria-label="本地模型名称"
              value={draft.model}
              maxLength={128}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="填写已自行安装的本地模型名称"
            />
          </label>
        )}
        <details className="pet-context-data-scope">
          <summary>数据范围与使用频率</summary>
          <p>
            模型仅收到临时引用编号与事项状态；标题、聊天和作者信息保留在
            BUGU。展示文字来自本地模板。
          </p>
          <p>
            可选模型通过本机
            Ollama（127.0.0.1:11434）运行，请使用已安装的本地模型，并确认服务的联网策略。
          </p>
          <p>
            自动出现沿用“自动话语”的频率、静默和每日上限。保存设置后可先预览；模型请求每天最多
            12 次，间隔至少 10 秒，预览、失败和取消也计入次数。
          </p>
        </details>
      </Disclosure>
      {(dirty || state?.config.enabled || preview) && (
        <div className="source-import-actions">
          <AppButton
            disabled={
              busy ||
              !state ||
              !dirty ||
              (draft.useModel && !draft.model.trim())
            }
            onClick={() =>
              void run(
                () =>
                  window.memo.pet.configureContext({
                    expectedVersion: state!.config.version,
                    config: draft,
                  }),
                (data) => {
                  setState(data)
                  setPreview(null)
                  setMessage('设置已保存，尚未生成话语。')
                },
              )
            }
          >
            保存事项话语设置
          </AppButton>
          <AppButton
            disabled={busy || !state || dirty || !state.config.enabled}
            onClick={() =>
              void run(
                () => window.memo.pet.previewContext(),
                (data) => {
                  setPreview(data)
                  setMessage(
                    data.mode === 'fallback'
                      ? '未生成事项话语，已回退本地预设。'
                      : '已生成预览，尚未显示到桌宠。',
                  )
                },
              )
            }
          >
            生成一条预览
          </AppButton>
          {busy && (
            <AppButton
              onClick={() => {
                void window.memo.pet
                  .cancelContext()
                  .then((r) => {
                    if (r.ok) setState(r.data)
                  })
                  .catch(() => undefined)
              }}
            >
              取消生成
            </AppButton>
          )}
        </div>
      )}
      {preview && (
        <div>
          <blockquote>{preview.text}</blockquote>
          <p>{preview.reason}</p>
          <p>
            {preview.hasReference ? '包含可查看的事项依据' : '不包含事项引用'} ·{' '}
            {preview.mode === 'model'
              ? '本地模型选择'
              : preview.mode === 'local'
                ? '本地事实模板'
                : '预设回退'}
          </p>
          <AppButton
            disabled={busy || dirty}
            onClick={() =>
              void run(
                () => window.memo.pet.showContext(preview.id),
                (data) => {
                  setState(data)
                  setMessage('话语已提交桌宠显示。')
                },
              )
            }
          >
            显示到桌宠
          </AppButton>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}

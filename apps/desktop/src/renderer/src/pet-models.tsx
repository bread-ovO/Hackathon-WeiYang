import { useEffect, useRef, useState } from 'react'
import type {
  CoreReply,
  PetChooseReply,
  PetImportReply,
  PetModelIssue,
  PetState,
} from '@memo/contracts'
import { FolderOpen, Cube, Check } from '@phosphor-icons/react'
import { AppButton } from './ui'
import './pet-models.css'
import { PetSpeechSettings } from './pet-speech-settings'

type Choice = Extract<PetChooseReply, { status: 'ready' | 'choose' }>
const initial: PetState = { currentModelId: null, display: false, models: [] }
function size(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function errorMessage(code: string) {
  if (code === 'PET_RUNTIME_INVALID')
    return '运行库未通过检查，请选择完整的受支持运行库目录。'
  if (code === 'PET_UNAVAILABLE')
    return '模型服务暂不可用，请重启应用后刷新模型库；上次操作结果以刷新为准。'
  if (code === 'SOURCE_CHANGED')
    return '模型目录在导入期间发生变化，请重新选择目录。'
  if (/SESSION|EXPIRED/.test(code))
    return '这次目录选择已失效，请重新选择模型目录。'
  if (/BUSY/.test(code)) return '另一个模型操作正在进行，请稍后重试。'
  if (/NOT_FOUND|UNKNOWN_MODEL/.test(code))
    return '模型已不存在，请刷新模型库。'
  if (code === 'STORAGE_LIMIT')
    return '目录扫描或模型容量超过限制，请选择更小的模型目录，或移除不需要的本地模型。'
  return '操作未完成，请重试或重新选择模型目录。'
}
function issueMessage(code: string) {
  const messages: Record<string, string> = {
    'invalid-root': '无法使用这个目录，请重新选择模型所在的普通文件夹。',
    'invalid-path': '资源引用超出目录或路径无效，请改为模型目录内的相对路径。',
    symlink: '资源包含符号链接，请替换为实际文件后重新导入。',
    missing: '缺少配套资源，请补齐此文件后重新导入。',
    'not-file': '资源不是普通文件，请检查引用是否指向了文件夹。',
    'read-failed': '无法读取此资源，请检查文件权限并重新选择目录。',
    limit: '资源数量或容量超过限制，请减少文件数量或选择更小的模型。',
    'invalid-json': 'JSON 格式无效，请重新导出或修复此文件。',
    'invalid-manifest': '模型入口配置无效，请从 Cubism 重新导出运行时模型。',
    'invalid-resource': '资源格式无效，请重新导出对应文件。',
    'unsupported-resource': '暂不支持此资源格式，请检查模型导出设置。',
  }
  return messages[code] ?? '资源未通过检查，请重新导出模型后再试。'
}
export function PetModels() {
  const [data, setData] = useState<PetState>(initial)
  const [busy, setBusy] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [message, setMessage] = useState('')
  const [choice, setChoice] = useState<Choice | null>(null)
  const [entry, setEntry] = useState('')
  const [action, setAction] = useState('')
  const [speech, setSpeech] = useState('你好，今天也一起慢慢来。')
  const [issues, setIssues] = useState<PetModelIssue[]>([])
  const [removing, setRemoving] = useState<string | null>(null)
  const alive = useRef(false),
    locked = useRef(false),
    sequence = useRef(0),
    session = useRef<string | null>(null),
    choosing = useRef(false)
  const api = () => window.memo.pet
  async function perform<T>(
    work: () => Promise<CoreReply<T>>,
    apply: (data: T, current: () => boolean) => void | Promise<void>,
  ) {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setMessage('')
    const id = ++sequence.current
    const current = () => alive.current && sequence.current === id
    try {
      const reply = await work()
      if (!current()) {
        if (choosing.current)
          void api()
            .cancelImport()
            .catch(() => {})
        return
      }
      if (reply.ok) await apply(reply.data, current)
      else if (reply.error === 'PET_OUTCOME_UNKNOWN') {
        setMessage('操作结果需要确认，正在重新读取模型库。')
        setChoice(null)
        setEntry('')
        setRemoving(null)
        session.current = null
        await api()
          .cancelImport()
          .catch(() => {})
        if (!current()) return
        try {
          const refreshed = await api().state()
          if (!current()) return
          if (refreshed.ok) {
            setData(refreshed.data)
            setLoaded(true)
            setMessage('已重新读取模型库，请以当前模型列表和选择为准。')
          } else {
            setMessage(
              '操作结果仍未确认，请重启应用后刷新模型库；请勿重复提交上次操作。',
            )
          }
        } catch {
          if (current())
            setMessage(
              '操作结果仍未确认，请重启应用后刷新模型库；请勿重复提交上次操作。',
            )
        }
      } else {
        setMessage(errorMessage(reply.error))
        if (/SESSION|EXPIRED/.test(reply.error)) {
          setChoice(null)
          session.current = null
        }
      }
    } catch {
      if (current()) setMessage('模型服务暂不可用，请稍后重试。')
    } finally {
      if (sequence.current === id) {
        locked.current = false
        choosing.current = false
        if (alive.current) setBusy(false)
      }
    }
  }
  async function refresh() {
    await perform(
      () => api().state(),
      (value) => {
        setData(value)
        setLoaded(true)
      },
    )
  }
  useEffect(() => {
    alive.current = true
    void refresh()
    return () => {
      alive.current = false
      sequence.current++
      locked.current = false
      if (session.current !== null || choosing.current)
        void api()
          .cancelImport()
          .catch(() => {})
      session.current = null
    }
  }, [])
  useEffect(() => {
    if (
      !data.display ||
      (data.renderStatus !== 'loading' && !data.presentation)
    )
      return
    const timer = setInterval(() => {
      if (locked.current) return
      void refresh()
    }, 2000)
    return () => clearInterval(timer)
  }, [data.display, data.renderStatus, data.presentation])
  useEffect(() => {
    setAction('')
  }, [data.currentModelId])
  async function choose() {
    if (locked.current) return
    choosing.current = true
    setIssues([])
    setRemoving(null)
    await perform(
      () => api().openImportDialog(),
      (value) => {
        if (value.status === 'cancelled') {
          setMessage('已取消目录选择。')
          return
        }
        if (value.status === 'no-model') {
          setChoice(null)
          session.current = null
          setMessage(
            value.cmo3Found
              ? '找到的是 .cmo3 编辑工程，请在 Live2D Cubism 中导出 .model3.json 运行时模型。'
              : '这个目录没有可导入的 .model3.json 模型。',
          )
          return
        }
        session.current = value.sessionId
        setChoice(value)
        setEntry(
          value.status === 'ready' ? value.entry : (value.entries[0] ?? ''),
        )
      },
    )
  }
  async function importChosen() {
    if (!choice || !entry) return
    await perform<PetImportReply>(
      () => api().importChosen(choice.sessionId, entry),
      async (value, current) => {
        setChoice(null)
        session.current = null
        if (value.status === 'invalid') {
          setIssues(value.issues)
          setMessage('模型未通过检查，请修复以下资源后重新选择。')
          await api()
            .cancelImport()
            .catch(() => {})
          return
        }
        setIssues([])
        setData((previous) => ({
          ...previous,
          models: previous.models.some((model) => model.id === value.model.id)
            ? previous.models
            : [...previous.models, value.model],
        }))
        setMessage(
          value.status === 'duplicate'
            ? '这个模型已在模型库中，没有重复导入。'
            : '模型已导入，可选为当前模型。',
        )
        try {
          const reply = await api().state()
          if (current()) {
            if (reply.ok) {
              setData(reply.data)
              setLoaded(true)
            } else setMessage('模型已导入，但列表刷新失败，请点击刷新。')
          }
        } catch {
          if (current()) setMessage('模型已导入，但列表刷新失败，请点击刷新。')
        }
      },
    )
  }
  async function cancelChoice() {
    await perform(
      () => api().cancelImport(),
      () => {
        setChoice(null)
        session.current = null
        setEntry('')
        setMessage('已取消导入。')
      },
    )
  }
  return (
    <section
      className="pet-models"
      aria-labelledby="pet-models-title"
      aria-busy={busy}
    >
      <div className="pet-models-heading">
        <div>
          <h2 id="pet-models-title">桌宠模型管理</h2>
          <p>导入 Live2D 运行时模型，保存在这台设备上。</p>
        </div>
        <div className="pet-models-actions">
          <AppButton disabled={busy} onClick={() => void refresh()}>
            刷新模型库
          </AppButton>
          <AppButton
            className="secondary"
            disabled={busy || choice !== null}
            onClick={() => void choose()}
          >
            <FolderOpen size={16} aria-hidden="true" />
            选择模型目录
          </AppButton>
        </div>
      </div>
      <p className="pet-models-note">
        支持 .model3.json 及其配套资源；不支持 .cmo3
        编辑工程。选择当前模型后，可在桌面显示。
      </p>
      <div className="pet-models-runtime">
        <div>
          <strong>
            {data.runtimeReady ? '运行库已就绪' : '尚未安装运行库'}
          </strong>
          <p>
            {data.runtimeReady
              ? '可以显示当前 Live2D 模型。'
              : '首次使用请选择受支持的 Cubism 5-r.5 运行库目录。'}
          </p>
        </div>
        <div className="pet-models-actions">
          <AppButton
            disabled={busy}
            onClick={() =>
              void perform(
                () => api().installRuntime(),
                (value) => setData(value),
              )
            }
          >
            选择运行库目录
          </AppButton>
          <AppButton
            className="primary"
            disabled={
              busy ||
              (!data.display && (!data.runtimeReady || !data.currentModelId))
            }
            onClick={() =>
              void perform(
                () => (data.display ? api().hide() : api().show()),
                (value) => setData(value),
              )
            }
          >
            {data.display ? '隐藏桌宠' : '显示桌宠'}
          </AppButton>
        </div>
      </div>
      <div className="pet-models-preferences" aria-label="桌宠窗口偏好">
        <label htmlFor="pet-scale">角色大小</label>
        <select
          id="pet-scale"
          disabled={busy}
          value={data.preferences?.scale ?? 1}
          onChange={(event) =>
            void perform(
              () => api().configure({ scale: Number(event.target.value) }),
              (value) => setData(value),
            )
          }
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((scale) => (
            <option key={scale} value={scale}>
              {Math.round(scale * 100)}%
            </option>
          ))}
        </select>
        <AppButton
          disabled={busy}
          aria-pressed={data.preferences?.alwaysOnTop ?? false}
          onClick={() =>
            void perform(
              () =>
                api().configure({
                  alwaysOnTop: !data.preferences?.alwaysOnTop,
                }),
              (value) => setData(value),
            )
          }
        >
          {data.preferences?.alwaysOnTop ? '取消置顶' : '置顶显示'}
        </AppButton>
        <AppButton
          disabled={busy}
          aria-pressed={data.preferences?.clickThrough ?? true}
          onClick={() =>
            void perform(
              () =>
                api().configure({
                  clickThrough: !(data.preferences?.clickThrough ?? true),
                }),
              (value) => setData(value),
            )
          }
        >
          {(data.preferences?.clickThrough ?? true)
            ? '关闭透明区穿透'
            : '开启透明区穿透'}
        </AppButton>
        <AppButton
          disabled={busy}
          onClick={() =>
            void perform(
              () => api().resetPosition(),
              (value) => setData(value),
            )
          }
        >
          找回桌宠
        </AppButton>
        <p>
          拖动角色调整位置。透明区域可点击下方应用；始终可以从这里隐藏桌宠。
        </p>
      </div>
      <PetSpeechSettings
        state={data.speech}
        busy={busy}
        onConfigure={(patch) =>
          perform(
            () => api().configureSpeech(patch),
            (value) => setData(value),
          )
        }
      />
      {data.display && data.renderStatus === 'ready' && (
        <div className="pet-models-presentation" aria-label="桌宠动作与气泡">
          <label htmlFor="pet-action">表情与动作</label>
          <div className="pet-models-actions">
            <select
              id="pet-action"
              value={action}
              disabled={busy}
              onChange={(event) => setAction(event.target.value)}
            >
              <option value="">保持待机</option>
              <optgroup label="动作">
                {data.catalog?.motions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="表情">
                {data.catalog?.expressions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            </select>
            <AppButton
              disabled={busy || !action}
              onClick={() =>
                void perform(
                  () => api().play(action),
                  (value) => setData(value),
                )
              }
            >
              播放动作
            </AppButton>
          </div>
          <label htmlFor="pet-speech">气泡文字</label>
          <textarea
            id="pet-speech"
            value={speech}
            maxLength={240}
            disabled={busy}
            rows={2}
            onChange={(event) => setSpeech(event.target.value)}
          />
          <div className="pet-models-actions">
            <AppButton
              disabled={busy || !speech.trim()}
              onClick={() =>
                void perform(
                  () =>
                    api().speak({
                      text: speech,
                      ...(action ? { actionId: action } : {}),
                    }),
                  (value) => setData(value),
                )
              }
            >
              显示气泡
            </AppButton>
            <AppButton
              disabled={busy || data.presentation?.kind !== 'bubble'}
              onClick={() =>
                void perform(
                  () => api().dismissBubble(),
                  (value) => setData(value),
                )
              }
            >
              关闭当前气泡
            </AppButton>
            <span className="pet-models-presentation-note">
              手动预览，不受自动话语开关影响。
            </span>
          </div>
        </div>
      )}
      {(data.display || data.renderStatus === 'error') && (
        <p className="pet-models-message" role="status">
          {data.renderStatus === 'ready'
            ? '桌宠正在显示。'
            : data.renderStatus === 'error'
              ? '模型无法显示，请重新导出模型或检查运行库后重试。'
              : '正在加载桌宠…'}
        </p>
      )}
      {message && (
        <p className="pet-models-message" role="status">
          {message}
        </p>
      )}
      {choice && (
        <div className="pet-models-import">
          <label htmlFor="pet-model-entry">模型入口</label>
          <select
            id="pet-model-entry"
            value={entry}
            disabled={busy}
            onChange={(event) => setEntry(event.target.value)}
          >
            {choice.entries.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
          <p>
            将复制模型资源到本地模型库，原目录保持不变。选择有效期为 10 分钟。
          </p>
          <div className="pet-models-actions">
            <AppButton disabled={busy} onClick={() => void cancelChoice()}>
              取消导入
            </AppButton>
            <AppButton
              className="primary"
              disabled={busy || !entry}
              onClick={() => void importChosen()}
            >
              导入模型
            </AppButton>
          </div>
        </div>
      )}
      {issues.length > 0 && (
        <div
          className="pet-models-issues"
          role="region"
          aria-label="模型资源检查结果"
        >
          <h3>需要修复的资源</h3>
          <ul>
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <strong>{issue.resource || '模型目录'}</strong>
                <span>{issueMessage(issue.code)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!loaded ? (
        <p className="pet-models-empty">
          {busy ? '正在读取模型库…' : '模型库暂不可用，请刷新重试。'}
        </p>
      ) : data.models.length === 0 ? (
        <div className="pet-models-empty">
          <Cube size={24} aria-hidden="true" />
          <span>还没有模型</span>
          <p>选择包含 .model3.json 的文件夹开始导入。</p>
        </div>
      ) : (
        <ul className="pet-models-list" aria-label="已导入的桌宠模型">
          {data.models.map((model) => (
            <li key={model.id}>
              <div className="pet-models-row">
                <Cube size={20} aria-hidden="true" />
                <div className="pet-models-name">
                  <strong>{model.entry}</strong>
                  <span>
                    {size(model.totalBytes)} ·{' '}
                    {new Date(model.importedAt).toLocaleDateString('zh-CN')}{' '}
                    导入
                  </span>
                </div>
                {data.currentModelId === model.id && (
                  <span className="pet-models-current">
                    <Check size={14} aria-hidden="true" />
                    当前模型
                  </span>
                )}
                <div className="pet-models-actions">
                  <AppButton
                    disabled={busy || choice !== null}
                    onClick={() =>
                      void perform(
                        () =>
                          api().select(
                            data.currentModelId === model.id ? null : model.id,
                          ),
                        (value) => {
                          setData(value)
                          setMessage(
                            value.currentModelId
                              ? '已更新当前模型。'
                              : '已取消当前模型选择。',
                          )
                        },
                      )
                    }
                  >
                    {data.currentModelId === model.id ? '取消选择' : '设为当前'}
                  </AppButton>
                  <AppButton
                    disabled={busy || choice !== null}
                    onClick={() => setRemoving(model.id)}
                  >
                    移除
                  </AppButton>
                </div>
              </div>
              {removing === model.id && (
                <div className="pet-models-remove">
                  <p>
                    移除本地已导入的副本，原目录不受影响。
                    {data.currentModelId === model.id
                      ? '当前选择也会清除。'
                      : ''}
                  </p>
                  <div className="pet-models-actions">
                    <AppButton
                      disabled={busy}
                      onClick={() => setRemoving(null)}
                    >
                      保留模型
                    </AppButton>
                    <AppButton
                      variant="destructive"
                      disabled={busy}
                      onClick={() =>
                        void perform(
                          () => api().remove(model.id),
                          (value) => {
                            setData(value)
                            setRemoving(null)
                            setMessage('已移除本地模型副本。')
                          },
                        )
                      }
                    >
                      确认移除
                    </AppButton>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

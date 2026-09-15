import { HelpTip } from './ui/help-tip'
import { Switch } from '@cloudflare/kumo/components/switch'
import './model-provider-settings.css'
import { useEffect, useState } from 'react'
import type {
  CredentialSummary,
  ModelConfig,
  ModelProviderSnapshot,
} from '@memo/contracts'
import { AppButton, AppInput } from './ui'
const names = {
  responses: 'OpenAI Responses API',
  'chat-completions': 'OpenAI Chat Completions API',
  'codex-cli': '本机 Codex',
  'claude-cli': '本机 Claude Code',
  'kimi-cli': 'Kimi Code（尚未开放）',
}
export function ModelProviderSettings({
  defaultOpen = false,
}: { defaultOpen?: boolean } = {}) {
  const [state, setState] = useState<ModelProviderSnapshot | null>(null)
  const [config, setConfig] = useState<ModelConfig | null>(null)
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    let mounted = true
    void window.memo.modelProvider.status().then((r) => {
      if (mounted && r.ok) {
        setState(r.data)
        setConfig(r.data.config)
      }
    })
    void window.memo.credentials.list().then((r) => {
      if (mounted && r.ok) setCredentials(r.data.credentials)
    })
    return () => {
      mounted = false
    }
  }, [])
  if (!config || !state) return <p>正在读取模型配置…</p>
  const api =
    config.provider === 'responses' || config.provider === 'chat-completions'
  const patch = (value: Partial<ModelConfig>) => {
    setConfig({ ...config, ...value })
    setMessage('')
  }
  let domain = ''
  try {
    domain = new URL(config.baseUrl).hostname
  } catch {
    /* invalid until saved */
  }
  async function importKey() {
    setBusy(true)
    try {
      const r = await window.memo.credentials.importFile({
        label: 'AI 分析 API Key',
        domain,
        purpose: 'model',
      })
      if (r.ok) {
        setCredentials(r.data.credentials)
        if (!r.data.cancelled) {
          const key = r.data.credentials
            .filter((c) => c.purpose === 'model' && c.domain === domain)
            .at(-1)
          if (key) patch({ credentialId: key.id })
        }
      } else setMessage('无法导入密钥，请检查服务地址及系统凭据库。')
    } catch {
      setMessage('密钥导入未成功。')
    } finally {
      setBusy(false)
    }
  }
  async function save(next = config) {
    if (!next) return
    setBusy(true)
    try {
      const r = await window.memo.modelProvider.configure(next)
      if (r.ok) {
        setState(r.data)
        setConfig(r.data.config)
        setMessage(
          next.enabled ? '配置已保存。' : '分析已关闭；手动管理事项仍可使用。',
        )
      } else
        setMessage(
          '保存失败，请检查 HTTPS 地址、模型名称、密钥或本机 CLI 是否已安装。',
        )
    } catch {
      setMessage('配置服务暂不可用。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="model-provider-settings"
      open={defaultOpen || undefined}
    >
      <summary>
        分析模型 ·{' '}
        {state.config.enabled ? names[state.config.provider] : '未启用'}
      </summary>
      <div className="model-provider-form">
        <label>
          接入方式
          <select
            aria-label="模型接入方式"
            value={config.provider}
            disabled={busy}
            onChange={(e) =>
              patch({
                provider: e.target.value as ModelConfig['provider'],
                model: '',
                enabled: false,
              })
            }
          >
            {Object.entries(names).map(([id, name]) => (
              <option key={id} value={id} disabled={id === 'kimi-cli'}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {api ? (
          <>
            <label>
              服务地址（Base URL）
              <AppInput
                aria-label="模型服务地址"
                placeholder="https://api.openai.com/v1"
                value={config.baseUrl}
                onChange={(e) =>
                  patch({ baseUrl: e.target.value, credentialId: '' })
                }
              />
            </label>
            <label>
              API Key
              <select
                aria-label="模型密钥"
                value={config.credentialId}
                onChange={(e) => patch({ credentialId: e.target.value })}
              >
                <option value="">选择已加密保存的密钥</option>
                {credentials
                  .filter((c) => c.purpose === 'model' && c.domain === domain)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </select>
            </label>
            <AppButton
              disabled={busy || !domain}
              onClick={() => void importKey()}
            >
              从文件导入 API Key
            </AppButton>
          </>
        ) : (
          <p>
            {state.availableClis.includes(config.provider)
              ? '已检测到本机 CLI。请先在该工具中完成登录；BUGU 沿用其授权。'
              : '未检测到 CLI，请先安装并在终端登录，再刷新此页面。'}{' '}
            使用该工具的模型服务和额度，不是本地模型推理。
          </p>
        )}
        <label>
          模型名称{!api && '（可留空，使用 CLI 默认值）'}
          <AppInput
            aria-label="分析模型名称"
            value={config.model}
            onChange={(e) => patch({ model: e.target.value })}
          />
        </label>
        <div className="model-provider-permission">
          <span className="connection-label">
            允许 AI 分析
            <HelpTip label="模型授权说明">
              启用后，后台自动整理已授权来源，并在聊天时发送当前项目上下文。关闭立即停止新的模型请求并取消进行中的调用；来源读取授权单独管理。
            </HelpTip>
          </span>
          <Switch
            aria-label="允许使用此服务分析所选会话"
            checked={config.enabled}
            onCheckedChange={(enabled) => void save({ ...config, enabled })}
            disabled={busy}
          />
        </div>

        <AppButton
          variant="primary"
          disabled={busy}
          onClick={() => void save()}
        >
          保存模型配置
        </AppButton>
        <details
          className="model-send-preview"
          onToggle={(event) => {
            if (event.currentTarget.open)
              void window.memo.modelProvider.status().then((r) => {
                if (r.ok) setState(r.data)
              })
          }}
        >
          <summary>最近调用的上下文</summary>
          {state.lastRequest ? (
            <>
              <p>
                {names[state.lastRequest.provider]} · {state.lastRequest.model}
              </p>
              <p>
                {state.lastRequest.destination} ·{' '}
                {new Date(state.lastRequest.sentAt).toLocaleString()}
              </p>
              <small>
                {state.lastRequest.purpose === 'task-chat'
                  ? '任务聊天'
                  : '自动事项分析'}{' '}
                · 仅保留本次启动的最近一次请求；调用失败不代表服务已收到
                {state.lastRequest.truncated
                  ? ' · 内容超过上限，预览已截断'
                  : ''}
              </small>
              {state.lastRequest.messages.map((item, i) => (
                <details key={i}>
                  <summary>
                    {item.role === 'system' ? '系统说明' : '来源与事项片段'} ·{' '}
                    {item.content.length} 字符
                  </summary>
                  <pre>{item.content}</pre>
                </details>
              ))}
            </>
          ) : (
            <p>本次启动尚未发送模型请求。</p>
          )}
        </details>
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  )
}

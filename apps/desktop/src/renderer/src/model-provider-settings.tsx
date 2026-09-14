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
  async function save() {
    if (!config) return
    setBusy(true)
    try {
      const r = await window.memo.modelProvider.configure(config)
      if (r.ok) {
        setState(r.data)
        setConfig(r.data.config)
        setMessage('配置已保存。下次分析使用此服务。')
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
          <span>允许分析所选会话</span>
          <Switch
            aria-label="允许使用此服务分析所选会话"
            checked={config.enabled}
            onCheckedChange={(enabled) => patch({ enabled })}
            disabled={busy}
          />
        </div>
        <p>
          主动分析或发送聊天时，才向此服务提供必要上下文。任务变更需另行确认。来源读取授权与模型调用授权分别管理。
        </p>
        <AppButton
          variant="primary"
          disabled={busy}
          onClick={() => void save()}
        >
          保存模型配置
        </AppButton>
        {message && <p role="status">{message}</p>}
      </div>
    </details>
  )
}

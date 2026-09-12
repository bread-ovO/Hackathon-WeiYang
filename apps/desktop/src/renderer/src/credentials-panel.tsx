import { useEffect, useRef, useState } from 'react'
import type { CoreReply, CredentialsSnapshot } from '@memo/contracts'
import { AppButton, AppInput } from './ui'
export function CredentialsPanel() {
  const [data, setData] = useState<CredentialsSnapshot>({
    credentials: [],
    encryptionAvailable: false,
  })
  const [label, setLabel] = useState(''),
    [domain, setDomain] = useState(''),
    [purpose, setPurpose] = useState<'source' | 'model'>('source')
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [removing, setRemoving] = useState<string | null>(null)
  const pending = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void window.memo.credentials
      .list()
      .then((r) => {
        if (mounted.current) {
          if (r.ok) setData(r.data)
          else setMessage('凭据列表暂不可用。')
        }
      })
      .catch(() => {
        if (mounted.current) setMessage('凭据列表暂不可用。')
      })
    return () => {
      mounted.current = false
    }
  }, [])
  async function run(
    work: () => Promise<CoreReply<CredentialsSnapshot>>,
    success: string,
  ) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const reply = await work()
      if (!mounted.current) return
      if (reply.ok) {
        setData(reply.data)
        setMessage(reply.data.cancelled ? '已取消，凭据未改变。' : success)
        setRemoving(null)
      } else
        setMessage(
          reply.error === 'VAULT_UNAVAILABLE'
            ? '系统加密服务不可用或另一个导入正在进行。'
            : reply.error === 'VAULT_WRITE_FAILED'
              ? '保存失败，原凭据保持不变。'
              : reply.error === 'VAULT_NOT_FOUND'
                ? '凭据已被移除，请刷新。'
                : '操作未完成，请检查输入或凭据文件。',
        )
    } catch {
      if (mounted.current) setMessage('凭据服务暂不可用。')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="credential-panel" aria-labelledby="credentials-heading">
      <div className="section-heading">
        <h2 id="credentials-heading">凭据</h2>
        <AppButton
          disabled={busy}
          onClick={() =>
            void run(() => window.memo.credentials.list(), '已刷新。')
          }
        >
          刷新凭据
        </AppButton>
      </div>
      <p className="credential-note">
        凭据由系统加密服务保护，界面仅保存引用。按域名与用途限制使用。
      </p>
      <p className="credential-status">
        {data.encryptionAvailable
          ? '系统加密可用'
          : '系统加密不可用，无法导入凭据'}
      </p>
      <form
        className="credential-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run(
            () =>
              window.memo.credentials.importFile({
                label: label.trim(),
                domain: domain.trim(),
                purpose,
              }),
            '凭据已加密保存，尚未绑定连接。',
          )
        }}
      >
        <label>
          名称
          <AppInput
            aria-label="凭据名称"
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="例如 GitHub"
            disabled={busy}
          />
        </label>
        <label>
          授权域名
          <AppInput
            aria-label="凭据授权域名"
            maxLength={253}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="api.github.com"
            disabled={busy}
          />
        </label>
        <label>
          用途
          <select
            aria-label="凭据用途"
            value={purpose}
            disabled={busy}
            onChange={(e) => setPurpose(e.target.value as 'source' | 'model')}
          >
            <option value="source">来源连接</option>
            <option value="model">模型服务</option>
          </select>
        </label>
        <AppButton
          type="submit"
          className="secondary"
          disabled={
            busy || !data.encryptionAvailable || !label.trim() || !domain.trim()
          }
        >
          导入凭据文件
        </AppButton>
      </form>
      <p className="credential-note">
        选择仅含一行 Token 的 UTF-8 文本文件（最多 8
        KiB）。原文件不会删除，请自行保管。连接授权与模型调用尚未接入。
      </p>
      {message && <p role="status">{message}</p>}
      <div className="credential-list">
        {data.credentials.length ? (
          data.credentials.map((c) => (
            <div className="credential-row" key={c.id}>
              <div>
                <strong>{c.label}</strong>
                <p>
                  {c.domain} ·{' '}
                  {c.purpose === 'source' ? '来源连接' : '模型服务'}
                </p>
              </div>
              <div className="credential-row-actions">
                {removing === c.id ? (
                  <>
                    <AppButton
                      disabled={busy}
                      onClick={() => setRemoving(null)}
                    >
                      取消
                    </AppButton>
                    <AppButton
                      variant="secondary-destructive"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => window.memo.credentials.remove(c.id),
                          '本机凭据已移除。服务端 Token 未被撤销。',
                        )
                      }
                    >
                      确认移除
                    </AppButton>
                  </>
                ) : (
                  <AppButton
                    disabled={busy}
                    onClick={() => setRemoving(c.id)}
                    aria-label={`移除凭据 ${c.label}`}
                  >
                    移除
                  </AppButton>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="credential-note">尚未保存凭据。</p>
        )}
      </div>
    </section>
  )
}

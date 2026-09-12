import { useEffect, useRef, useState } from 'react'
import type {
  CoreReply,
  PluginSnapshot,
  CredentialSummary,
} from '@memo/contracts'
import { AppButton } from './ui'
export function PluginManager() {
  const [data, setData] = useState<PluginSnapshot>({ plugins: [] })
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [projectId, setProjectId] = useState(''),
    [credentialId, setCredentialId] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [remove, setRemove] = useState<string | null>(null)
  const pending = useRef(false),
    mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void Promise.all([
      window.memo.plugins.list(),
      window.memo.workspace.list(),
      window.memo.credentials.list(),
    ])
      .then(([p, w, c]) => {
        if (!mounted.current) return
        if (p.ok) setData({ ...p.data, trial: undefined })
        if (w.ok) {
          setProjects(w.data.projects)
          setProjectId(w.data.projects[0]?.id ?? '')
        }
        if (c.ok) setCredentials(c.data.credentials)
      })
      .catch(() => {
        if (mounted.current) setMessage('插件服务暂不可用。')
      })
    return () => {
      mounted.current = false
    }
  }, [])
  async function run(
    action: () => Promise<CoreReply<PluginSnapshot>>,
    success: string,
    acceptTrial = false,
  ) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const r = await action()
      if (!mounted.current) return
      if (r.ok) {
        setData({ ...r.data, trial: acceptTrial ? r.data.trial : undefined })
        setMessage(r.data.cancelled ? '已取消，未启用新的插件。' : success)
        setRemove(null)
      } else {
        setData((old) => ({ ...old, trial: undefined }))
        setMessage(
          r.error === 'PLUGIN_TRIAL_FAILED'
            ? '试运行失败，插件未启用。请检查授权范围、凭据和数据格式。'
            : r.error === 'PLUGIN_UNAVAILABLE'
              ? '操作正在进行或尚未到下一次采样时间，请稍后重试。'
              : r.error === 'PLUGIN_CONFLICT'
                ? '确认已失效，请重新选择插件并试运行。'
                : '操作未完成，请刷新后检查插件配置。',
        )
      }
    } catch {
      if (mounted.current) setMessage('插件服务暂不可用。')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const selected = data.inspection
  const allowed = credentials.filter(
    (c) => c.purpose === 'source' && c.domain === selected?.domain,
  )
  return (
    <section className="plugin-panel" aria-label="声明式插件管理">
      <div className="plugin-heading">
        <div>
          <h2>来源插件</h2>
          <p>安装只读的声明式来源，先确认权限与样例，再开始采集。</p>
        </div>
        <AppButton
          disabled={busy}
          onClick={() =>
            void run(
              () => window.memo.plugins.inspect(),
              '已读取插件，请确认读取范围。',
            )
          }
        >
          安装插件
        </AppButton>
      </div>
      {selected && (
        <div className="plugin-preview">
          <strong>
            {selected.displayName}{' '}
            <span className="muted">{selected.version}</span>
          </strong>
          <p>
            {selected.kind === 'http-json'
              ? `仅访问 HTTPS 域名：${selected.domain}`
              : `选择目录后仅读取：${selected.file}`}
          </p>
          <p>
            {selected.credentialRequired
              ? '需要该域名的来源凭据，插件不获得凭据明文。'
              : '不需要凭据。'}
            {selected.permissionChanged
              ? ' 此版本读取权限有变化，需要重新授权。'
              : ''}
          </p>
          {selected.previousScope && (
            <p>当前版本权限：{selected.previousScope}</p>
          )}
          {selected.credentialPurpose && (
            <p>声明用途：{selected.credentialPurpose}</p>
          )}
          <div className="plugin-fields">
            <label>
              收录项目
              <select
                aria-label="插件收录项目"
                disabled={busy}
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value)
                  setData({ ...data, trial: undefined })
                }}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {selected.credentialRequired && (
              <label>
                来源凭据
                <select
                  aria-label="插件来源凭据"
                  disabled={busy}
                  value={credentialId}
                  onChange={(e) => {
                    setCredentialId(e.target.value)
                    setData({ ...data, trial: undefined })
                  }}
                >
                  <option value="">选择已保存的凭据</option>
                  {allowed.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {!projects.length && <p>先在“我的工作区”创建项目，再安装来源。</p>}
          {selected.credentialRequired && !allowed.length && (
            <p>请先到设置中导入匹配域名的来源凭据。</p>
          )}
          <div className="plugin-actions">
            <AppButton
              disabled={
                busy ||
                !projectId ||
                (selected.credentialRequired && !credentialId)
              }
              onClick={() =>
                void run(
                  () =>
                    window.memo.plugins.trial({
                      inspectionId: selected.inspectionId,
                      projectId,
                      ...(selected.credentialRequired ? { credentialId } : {}),
                    }),
                  '试运行通过，样例未写入事项库。',
                  true,
                )
              }
            >
              {selected.kind === 'local-jsonl'
                ? '选择目录并试运行'
                : '授权并试运行'}
            </AppButton>
            {data.trial && (
              <>
                <span>
                  样例 {data.trial.eventCount} 条
                  {data.trial.done ? '' : '（部分批次）'}
                </span>
                <AppButton
                  disabled={busy}
                  variant="primary"
                  onClick={() =>
                    void run(
                      () => window.memo.plugins.activate(data.trial!.trialId),
                      '插件已启用，将按声明间隔采集。',
                    )
                  }
                >
                  启用插件
                </AppButton>
              </>
            )}
          </div>
        </div>
      )}
      <div className="plugin-installed">
        {data.plugins.map((p) => (
          <div className="plugin-row" key={p.id}>
            <div>
              <strong>{p.displayName}</strong>
              <p>
                {p.version} ·{' '}
                {p.status === 'active'
                  ? '已启用'
                  : p.status === 'disabled'
                    ? '已停用'
                    : '异常暂停'}{' '}
                · 已收录 {p.eventCount} 条
              </p>
              {p.status !== 'active' && (
                <p>重新安装并试运行可恢复；历史数据保留。</p>
              )}
            </div>
            <div className="plugin-actions">
              {remove === p.id ? (
                <>
                  <span>保留历史并卸载？</span>
                  <AppButton
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => window.memo.plugins.uninstall(p.id),
                        '已卸载插件，已收录历史保留。',
                      )
                    }
                  >
                    确认卸载
                  </AppButton>
                  <AppButton disabled={busy} onClick={() => setRemove(null)}>
                    取消
                  </AppButton>
                </>
              ) : (
                <>
                  {p.status === 'active' && (
                    <>
                      <AppButton
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => window.memo.plugins.sync(p.id),
                            '同步完成。',
                          )
                        }
                      >
                        立即同步
                      </AppButton>
                      <AppButton
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => window.memo.plugins.disable(p.id),
                            '插件已停用，在途读取已取消。',
                          )
                        }
                      >
                        停用
                      </AppButton>
                    </>
                  )}
                  <AppButton disabled={busy} onClick={() => setRemove(p.id)}>
                    卸载
                  </AppButton>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {!data.plugins.length && !selected && (
        <p className="muted">尚未安装插件。请选择 manifest JSON 文件开始。</p>
      )}
      <div className="plugin-actions">
        <AppButton
          disabled={busy}
          onClick={() =>
            void run(() => window.memo.plugins.list(), '列表已刷新。')
          }
        >
          刷新插件
        </AppButton>
        {message && <p role="status">{message}</p>}
      </div>
    </section>
  )
}

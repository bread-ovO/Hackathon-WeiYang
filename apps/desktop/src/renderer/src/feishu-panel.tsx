import { useEffect, useRef, useState } from 'react'
import type {
  CoreReply,
  CredentialSummary,
  FeishuConnection,
  FeishuRecords,
  FeishuSnapshot,
} from '@memo/contracts'
import { AppButton, AppInput } from './ui'
import { ingestionErrors } from './ingestion-panel'
import './feishu-panel.css'
const errors: Record<string, string> = {
  ...ingestionErrors,
  FEISHU_AUTH_FAILED:
    '飞书凭据无效或已过期，请更新凭据后重新连接。此处不会自动刷新令牌。',
  FEISHU_PERMISSION_DENIED: '没有读取所选会话的权限，请核对凭据可见范围。',
  FEISHU_RATE_LIMITED: '飞书已限流，将按指定时间再检查；手动同步不能绕过等待。',
  FEISHU_API_FAILED: '飞书接口本次未成功，当前窗口和已保存进度保留。',
  FEISHU_HTTP_FAILED: '网络请求失败，当前窗口和已保存进度保留。',
  FEISHU_INVALID_RESPONSE: '返回数据未通过校验，本页未提交。',
  FEISHU_CREDENTIAL_UNAVAILABLE: '本地凭据不可用，请在设置中检查来源凭据。',
  FEISHU_PAGE_LOOP:
    '分页出现重复，已停止推进。可重新读取当前窗口，不会跳过历史。',
  FEISHU_PAGE_LIMIT: '当前窗口分页达到上限，需人工检查；系统不会跳过剩余历史。',
  FEISHU_CANCELLED: '本次读取已取消，已确认的进度保留。',
  FEISHU_BUSY: '当前会话正在读取，请稍后刷新。',
  FEISHU_NOT_DUE: '尚未到允许读取的时间，或当前没有可重读窗口。',
  FEISHU_INVALID: '请检查会话 ID、起点与项目。',
  FEISHU_UNAVAILABLE: '飞书连接服务暂不可用。',
  FEISHU_FAILED: '操作未完成，请刷新后查看当前状态。',
}
const statusLabels = {
  active: '已启用',
  paused: '已暂停',
  revoked: '已撤销',
  error: '需要检查',
} as const
const roles = {
  user: '人类发送者',
  assistant: '助手',
  tool: '工具',
  system: '系统',
} as const
const time = (value: number | string) => new Date(value).toLocaleString()
function FeishuRecordList({ connection }: { connection: FeishuConnection }) {
  const [data, setData] = useState<FeishuRecords | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const mounted = useRef(false),
    pending = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function load(cursor?: string) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const r = await window.memo.feishu.records({
        id: connection.id,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      })
      if (!mounted.current) return
      if (r.ok)
        setData((old) =>
          cursor && old
            ? {
                ...r.data,
                records: [
                  ...old.records,
                  ...r.data.records.filter(
                    (e) => !old.records.some((p) => p.id === e.id),
                  ),
                ],
              }
            : r.data,
        )
      else setMessage('会话记录读取失败，请刷新。')
    } catch {
      if (mounted.current) setMessage('本地核心暂不可用。')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section aria-label={`飞书观察记录 ${connection.chatId}`}>
      <AppButton disabled={busy} onClick={() => void load()}>
        {data ? '刷新会话记录' : '查看已收录记录'}
      </AppButton>
      {data && (
        <>
          <p>仅展示所选会话中已收录的记录，不代表所有聊天或平台最新状态。</p>
          {data.records.map((r) => (
            <article key={r.id} className="feishu-observation">
              <strong>
                {roles[r.role]} ·{' '}
                {r.operation === 'retract' ? '明确撤回' : '消息记录'}
              </strong>
              <p>
                消息 {r.externalId} · 修订 {r.revision}
              </p>
              {r.operation === 'retract' ? (
                <p>该记录明确表示消息撤回，不等于取消事项。</p>
              ) : (
                <blockquote>{r.text}</blockquote>
              )}
              <p>
                来源标注时间：{time(r.occurredAt)} · 收录时间：
                {time(r.receivedAt)}
              </p>
            </article>
          ))}
          {!data.records.length && <p>暂无已收录记录。</p>}
          {data.nextCursor && (
            <AppButton
              disabled={busy}
              onClick={() => void load(data.nextCursor!)}
            >
              加载更多会话记录
            </AppButton>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
export function FeishuPanel({
  onGoCredentials,
}: {
  onGoCredentials?: () => void
}) {
  const [data, setData] = useState<FeishuSnapshot>({ connections: [] }),
    [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [projectId, setProjectId] = useState(''),
    [chatId, setChatId] = useState(''),
    [credentialId, setCredentialId] = useState(''),
    [start, setStart] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const mounted = useRef(false),
    pending = useRef(false),
    generation = useRef(0)
  async function refresh(auxiliary = false) {
    if (pending.current) return
    const seq = ++generation.current
    try {
      const r = await window.memo.feishu.list()
      if (!mounted.current || seq !== generation.current) return
      if (r.ok) setData(r.data)
      else setMessage('飞书连接读取失败。')
      if (auxiliary) {
        const [w, c] = await Promise.all([
          window.memo.workspace.list(),
          window.memo.credentials.list(),
        ])
        if (!mounted.current || seq !== generation.current) return
        if (w.ok) setProjects(w.data.projects)
        if (c.ok)
          setCredentials(
            c.data.credentials.filter(
              (x) => x.purpose === 'source' && x.domain === 'open.feishu.cn',
            ),
          )
      }
    } catch {
      if (mounted.current && seq === generation.current)
        setMessage('飞书连接服务暂不可用。')
    }
  }
  useEffect(() => {
    mounted.current = true
    void refresh(true)
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh()
    }, 5000)
    return () => {
      mounted.current = false
      generation.current++
      window.clearInterval(timer)
    }
  }, [])
  async function run(work: () => Promise<CoreReply<FeishuSnapshot>>) {
    if (pending.current) return
    pending.current = true
    generation.current++
    setBusy(true)
    setMessage('')
    try {
      const r = await work()
      if (!mounted.current) return
      if (r.ok) {
        setData(r.data)
        setMessage('连接状态已更新。')
      } else setMessage(errors[r.error] ?? '操作结果需确认，请刷新连接。')
    } catch {
      if (mounted.current)
        setMessage('操作结果需确认，请刷新连接，不要直接重复提交。')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  function connect() {
    const date = new Date(start),
      startTime = date.getTime()
    const local = Number.isFinite(startTime)
      ? new Date(startTime - date.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, start.length)
      : ''
    if (
      !start ||
      !Number.isSafeInteger(startTime) ||
      startTime < 0 ||
      startTime % 1000 !== 0 ||
      startTime >= Date.now() ||
      local !== start
    ) {
      setMessage(
        '请选择过去的明确历史起点，精确到秒；无法确认的本地时间不会自动校正。',
      )
      return
    }
    void run(() =>
      window.memo.feishu.connect({
        projectId,
        chatId: chatId.trim(),
        credentialId,
        startTime,
      }),
    )
  }
  return (
    <section className="source-import feishu-panel" aria-label="飞书会话连接">
      <p>
        指定一个会话与历史起点，验证读取权限后启用分窗采样。只读取凭据有权访问的范围，不发现其他会话，也不自动刷新过期令牌。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          connect()
        }}
      >
        <div className="feishu-fields">
          <label>
            项目
            <select
              aria-label="飞书项目"
              value={projectId}
              disabled={busy}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">选择项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            会话 ID
            <AppInput
              aria-label="飞书会话ID"
              placeholder="oc_…"
              maxLength={256}
              value={chatId}
              disabled={busy}
              onChange={(e) => setChatId(e.target.value)}
            />
          </label>
          <label>
            读取凭据
            <select
              aria-label="飞书读取凭据"
              value={credentialId}
              disabled={busy}
              onChange={(e) => setCredentialId(e.target.value)}
            >
              <option value="">选择 open.feishu.cn 凭据</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            历史起点（本机时区）
            <AppInput
              aria-label="飞书历史起点"
              type="datetime-local"
              step={1}
              value={start}
              disabled={busy}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
        </div>
        <div className="source-import-actions">
          <AppButton
            type="submit"
            disabled={
              busy || !projectId || !credentialId || !chatId.trim() || !start
            }
          >
            验证并启用会话
          </AppButton>
          <AppButton disabled={busy} onClick={() => void refresh(true)}>
            刷新飞书连接
          </AppButton>
        </div>
      </form>
      {!credentials.length && (
        <p className="credential-hint">
          需要先导入用途为来源、域名为 open.feishu.cn 的凭据。
          <AppButton className="text-button" onClick={onGoCredentials}>
            前往设置导入凭据
          </AppButton>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {data.connections.map((c) => (
        <article className="feishu-connection" key={c.id}>
          <h3>{c.chatId}</h3>
          <p>
            {projects.find((p) => p.id === c.projectId)?.name ?? '所属项目'} ·{' '}
            {statusLabels[c.status]} · 已收录 {c.eventCount} 条
          </p>
          <p>所选历史起点：{time(c.startTime)}</p>
          <p>
            已读取至：
            {c.completedThrough === null
              ? '尚未完整读取首个窗口'
              : time(c.completedThrough)}
          </p>
          <p>表示该时间范围已读取；后续补写或修改仍可能未收录。</p>
          <p>
            {'最近读取范围'}：{time(c.windowStart)} — {time(c.windowEnd)}
          </p>
          <p>
            最后成功读取：{c.lastSuccessAt ? time(c.lastSuccessAt) : '尚未成功'}{' '}
            · 下次允许采样：{c.nextPollAt ? time(c.nextPollAt) : '等待调度'}
          </p>
          {c.errorCode && (
            <p role="status">
              {errors[c.errorCode]} · 连续失败 {c.failureCount} 次
            </p>
          )}
          <div className="source-import-actions">
            <AppButton
              disabled={busy || c.status === 'revoked'}
              onClick={() =>
                void run(() =>
                  window.memo.feishu.setEnabled(c.id, c.status === 'paused'),
                )
              }
            >
              {c.status === 'paused' ? '恢复会话采样' : '暂停会话采样'}
            </AppButton>
            <AppButton
              disabled={busy || c.status === 'paused' || c.status === 'revoked'}
              onClick={() => void run(() => window.memo.feishu.sync(c.id))}
            >
              同步会话
            </AppButton>
            <AppButton
              disabled={
                busy ||
                !c.windowActive ||
                c.status === 'paused' ||
                c.status === 'revoked'
              }
              onClick={() =>
                void run(() => window.memo.feishu.restartWindow(c.id))
              }
            >
              重新读取当前窗口
            </AppButton>
            <AppButton
              disabled={busy || c.status === 'revoked'}
              onClick={() => void run(() => window.memo.feishu.revoke(c.id))}
            >
              撤销会话授权
            </AppButton>
          </div>
          <p>
            同窗重读保留原时间范围，从首个分页重新读取并去重，不跳过历史；仍需遵守限流等待。
          </p>
          <FeishuRecordList connection={c} />
        </article>
      ))}
    </section>
  )
}

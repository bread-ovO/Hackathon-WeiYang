import { useEffect, useRef, useState } from 'react'
import type {
  CoreReply,
  CredentialSummary,
  GithubConnection,
  GithubRecords,
  GithubSnapshot,
} from '@memo/contracts'
import { AppButton, AppInput } from './ui'
import { ingestionErrors } from './ingestion-panel'
import './github-panel.css'
const errors: Record<string, string> = {
  ...ingestionErrors,
  GITHUB_RATE_LIMITED: 'GitHub 已限流，已保存等待时间，暂时无法继续请求。',
  GITHUB_AUTH_FAILED: 'GitHub 授权未通过，请检查所选凭据的仓库读取权限。',
  GITHUB_REPOSITORY_CHANGED:
    '仓库身份发生变化，已停止采样，请核对仓库后重新连接。',
  GITHUB_INVALID_RESPONSE: '返回记录未通过验证，本次未提交。',
  GITHUB_CREDENTIAL_UNAVAILABLE: '所选凭据不可用，请在设置中检查凭据。',
  GITHUB_REQUEST_FAILED: '本次请求失败，将按退避时间再检查。',
  GITHUB_BUSY: '当前连接正在采样，请稍后刷新。',
  GITHUB_NOT_DUE: '尚未到允许采样的时间，手动同步不能绕过限流。',
  GITHUB_CANCELLED: '采样已取消，已保存的进度保留。',
  GITHUB_INVALID: '连接参数无效，请检查项目与仓库名称。',
  GITHUB_UNAVAILABLE: 'GitHub 连接服务暂不可用。',
}
const statuses = {
  active: '已启用',
  paused: '已暂停',
  revoked: '已撤销',
  error: '需要检查',
} as const
function PRObservation({
  record,
}: {
  record: GithubRecords['records'][number]
}) {
  let pr: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(record.text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      pr = parsed as Record<string, unknown>
  } catch {
    /* historical plain text remains text */
  }
  const branch = (value: unknown) =>
    value &&
    typeof value === 'object' &&
    'ref' in value &&
    typeof value.ref === 'string'
      ? value.ref
      : '未知'
  const scalar = (value: unknown) => (typeof value === 'string' ? value : null)
  return (
    <article className="github-observation">
      {pr?.kind === 'github-pull-request' && typeof pr.title === 'string' ? (
        <>
          <strong>
            PR #{typeof pr.number === 'number' ? pr.number : '?'} · {pr.title}
          </strong>
          <p>
            观测状态：
            {pr.state === 'merged'
              ? '已合并'
              : pr.state === 'closed'
                ? '已关闭'
                : pr.state === 'open'
                  ? '打开中'
                  : '未知'}
            {pr.draft === true ? ' · 草稿' : ''}
          </p>
          <p>
            分支：{branch(pr.head)} → {branch(pr.base)}
          </p>
          {(['createdAt', 'closedAt', 'mergedAt'] as const).map(
            (key) =>
              scalar(pr?.[key]) && (
                <p key={key}>
                  {
                    {
                      createdAt: '创建时间',
                      closedAt: '关闭时间',
                      mergedAt: '合并时间',
                    }[key]
                  }
                  ：{scalar(pr?.[key])}
                </p>
              ),
          )}
        </>
      ) : (
        <pre>{record.text}</pre>
      )}
      <p>
        来源标注时间：{record.occurredAt} · 收录时间：
        {new Date(record.receivedAt).toLocaleString()}
      </p>
    </article>
  )
}
function GithubRecordList({ connection }: { connection: GithubConnection }) {
  const [data, setData] = useState<GithubRecords | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const active = useRef(true),
    pending = useRef(false)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  async function load(cursor?: string) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const r = await window.memo.github.records({
        id: connection.id,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      })
      if (!active.current) return
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
      else setMessage('观察记录读取失败，请刷新。')
    } catch {
      if (active.current) setMessage('本地核心暂不可用。')
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <section aria-label={`PR观察记录 ${connection.owner}/${connection.repo}`}>
      <AppButton disabled={busy} onClick={() => void load()}>
        {data ? '刷新观察记录' : '查看 PR 观察记录'}
      </AppButton>
      {data && (
        <>
          <p>
            仅代表已收录的观察，不保证平台最新；关闭或合并 PR 不会自动完成事项。
          </p>
          {data.records.map((r) => (
            <PRObservation key={r.id} record={r} />
          ))}
          {!data.records.length && <p>暂无已收录记录。</p>}
          {data.nextCursor && (
            <AppButton
              disabled={busy}
              onClick={() => void load(data.nextCursor!)}
            >
              加载更多观察记录
            </AppButton>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
export function GithubPanel({
  onGoCredentials,
}: {
  onGoCredentials?: () => void
}) {
  const [data, setData] = useState<GithubSnapshot>({ connections: [] }),
    [projects, setProjects] = useState<{ id: string; name: string }[]>([]),
    [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [projectId, setProjectId] = useState(''),
    [owner, setOwner] = useState(''),
    [repo, setRepo] = useState(''),
    [credentialId, setCredentialId] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const mounted = useRef(false),
    pending = useRef(false),
    generation = useRef(0)
  async function refresh(auxiliary = false) {
    if (pending.current) return
    const seq = ++generation.current
    try {
      const result = await window.memo.github.list()
      if (!mounted.current || seq !== generation.current) return
      if (result.ok) setData(result.data)
      else setMessage('GitHub 连接读取失败。')
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
              (x) => x.purpose === 'source' && x.domain === 'api.github.com',
            ),
          )
      }
    } catch {
      if (mounted.current && seq === generation.current)
        setMessage('连接服务暂不可用。')
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
  async function run(work: () => Promise<CoreReply<GithubSnapshot>>) {
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
      } else setMessage(errors[r.error] ?? '操作未完成，请刷新确认当前状态。')
    } catch {
      if (mounted.current)
        setMessage('操作结果需要确认，请刷新连接；不要直接重复提交。')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="source-import github-panel" aria-label="GitHub仓库连接">
      <p>
        仅访问所选仓库的 PR
        记录，凭据保存在本机保险库。验证通过后启用定时采样，不会自动完成事项。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void run(() =>
            window.memo.github.connect({
              projectId,
              owner: owner.trim(),
              repo: repo.trim(),
              credentialId,
            }),
          )
        }}
      >
        <div className="github-fields">
          <label>
            项目
            <select
              aria-label="GitHub项目"
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
            所有者
            <AppInput
              aria-label="GitHub所有者"
              maxLength={39}
              value={owner}
              disabled={busy}
              onChange={(e) => setOwner(e.target.value)}
            />
          </label>
          <label>
            仓库
            <AppInput
              aria-label="GitHub仓库名"
              maxLength={100}
              value={repo}
              disabled={busy}
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
          <label>
            读取凭据
            <select
              aria-label="GitHub读取凭据"
              value={credentialId}
              disabled={busy}
              onChange={(e) => setCredentialId(e.target.value)}
            >
              <option value="">选择 api.github.com 凭据</option>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="source-import-actions">
          <AppButton
            type="submit"
            disabled={
              busy ||
              !projectId ||
              !credentialId ||
              !owner.trim() ||
              !repo.trim()
            }
          >
            验证并启用仓库
          </AppButton>
          <AppButton disabled={busy} onClick={() => void refresh(true)}>
            刷新仓库连接
          </AppButton>
        </div>
      </form>
      {!credentials.length && (
        <p className="credential-hint">
          需要先导入用途为来源、域名为 api.github.com 的凭据。
          <AppButton className="text-button" onClick={onGoCredentials}>
            前往设置导入凭据
          </AppButton>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {data.connections.map((c) => (
        <article className="github-connection" key={c.id}>
          <h3>
            {c.owner}/{c.repo}
          </h3>
          <p>
            {projects.find((p) => p.id === c.projectId)?.name ?? '所属项目'} ·{' '}
            {statuses[c.status]} · 已收录 {c.eventCount} 条
          </p>
          <p>
            最近成功：
            {c.lastSuccessAt
              ? new Date(c.lastSuccessAt).toLocaleString()
              : '尚未成功采样'}
          </p>
          <p>
            下一次允许采样：
            {c.nextPollAt
              ? new Date(c.nextPollAt).toLocaleString()
              : '等待调度'}{' '}
            · 连续失败 {c.failureCount} 次
          </p>
          {c.errorCode && <p>{errors[c.errorCode]}</p>}
          <div className="source-import-actions">
            <AppButton
              disabled={busy || c.status === 'revoked'}
              onClick={() =>
                void run(() =>
                  window.memo.github.setEnabled(c.id, c.status === 'paused'),
                )
              }
            >
              {c.status === 'paused' ? '恢复仓库采样' : '暂停仓库采样'}
            </AppButton>
            <AppButton
              disabled={busy || c.status === 'paused' || c.status === 'revoked'}
              onClick={() => void run(() => window.memo.github.sync(c.id))}
            >
              同步仓库
            </AppButton>
            <AppButton
              disabled={busy || c.status === 'revoked'}
              onClick={() => void run(() => window.memo.github.revoke(c.id))}
            >
              撤销仓库授权
            </AppButton>
          </div>
          <GithubRecordList connection={c} />
        </article>
      ))}
    </section>
  )
}

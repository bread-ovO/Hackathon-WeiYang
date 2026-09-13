import { useEffect, useRef, useState } from 'react'
import { AppButton } from './ui'
import './source-presets.css'

export function SourcePresets({ onDemoReady }: { onDemoReady(): void }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function start() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setMessage('正在准备体验项目、试运行并收录记录…')
    try {
      const result = await window.memo.plugins.startDemo()
      if (result.ok) {
        const plugin = result.data.plugins.find(
          (p) => p.id === 'bugu-builtin-demo',
        )
        // Let the normal background consumer run; never fabricate tasks in the UI.
        for (let attempt = 0; plugin && attempt < 10; attempt++) {
          const workspace = await window.memo.workspace.list({
            projectId: plugin.projectId,
          })
          if (workspace.ok && workspace.data.tasks.length) break
          await new Promise((resolve) => setTimeout(resolve, 400))
        }
        if (mounted.current) onDemoReady()
      } else if (mounted.current)
        setMessage(
          '体验暂未完成，请重试。已收录记录会保留，不会重复建立已启用的插件。',
        )
    } catch {
      if (mounted.current) setMessage('插件服务暂不可用，请稍后重试。')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  function configure(id: string) {
    const target = document.getElementById(id)
    target?.scrollIntoView({ block: 'start' })
    target?.focus({ preventScroll: true })
  }
  return (
    <section className="source-presets" aria-label="预置来源">
      <div className="source-starter">
        <div>
          <span className="source-eyebrow">无需账号 · 真实采集流程</span>
          <h2>先用三条工作记录，认识不咕</h2>
          <p>
            在独立体验项目中运行预置插件，生成待确认候选。全部是虚构数据，不读取你的个人文件。
          </p>
        </div>
        <AppButton
          variant="primary"
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? '正在准备…' : '一键体验'}
        </AppButton>
      </div>
      {message && <p role="status">{message}</p>}
      <div className="source-preset-grid">
        {[
          [
            'preset-feishu',
            '飞书',
            '从指定会话中收录工作约定与后续消息。',
            '配置飞书',
          ],
          [
            'preset-github',
            'GitHub',
            '跟踪指定仓库的 PR，保留交付记录。',
            '配置 GitHub',
          ],
          [
            'preset-local',
            '本地 JSONL',
            '导入工作记录，按文件新增内容继续同步。',
            '导入本地记录',
          ],
        ].map(([id, name, description, button]) => (
          <article key={id}>
            <div className="source-preset-title">
              <h3>{name}</h3>
              <span>内置</span>
            </div>
            <p>{description}</p>
            <AppButton variant="secondary" onClick={() => configure(id!)}>
              {button}
            </AppButton>
          </article>
        ))}
      </div>
      <p className="source-preset-note">
        以上来源无需安装插件。连接你自己的数据时，再选择项目并配置读取范围与凭据。
      </p>
    </section>
  )
}

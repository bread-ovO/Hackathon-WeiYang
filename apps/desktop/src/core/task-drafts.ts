import type { ChatDraft } from '@memo/contracts'
import type { openStore } from '@memo/storage'
const statuses: Record<string, string> = {
  todo: '待办',
  in_progress: '进行中',
  waiting: '等待反馈',
  completed: '已完成',
  cancelled: '已取消',
}
/** A literal, local record recap. Never upgrades a model suggestion to a verified fact. */
export function buildTaskDraft(
  store: ReturnType<typeof openStore>,
  projectId: string,
  kind: ChatDraft['kind'],
  now = new Date(),
): ChatDraft {
  if (!store.tasks.listProjects().some((p) => p.id === projectId))
    throw Error('NOT_FOUND')
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const page = store.tasks.listPage({
    projectId,
    admission: 'accepted',
    archive: 'all',
    limit: 20,
    ...(kind === 'daily'
      ? {
          updatedSince: since,
          updatedBefore: new Date(now.getTime() + 1).toISOString(),
        }
      : {}),
  })
  const references: ChatDraft['references'] = []
  const sections = page.items.map((task) => {
    const n = references.length + 1
    references.push({
      label: `事项记录 ${task.id} · v${task.version}`,
      taskId: task.id,
      version: task.version,
      quote: `${task.title}；手动状态：${statuses[task.status]}`,
    })
    const lines = [
      `${task.title} [${n}]`,
      `手动状态：${statuses[task.status]}${task.dueAt ? `；截止：${task.dueAt}` : ''}。`,
    ]
    const suggestion = store.taskAnalysis.forTask(projectId, task.id)
    if (suggestion) {
      // forTask revalidates original exact-source quotations before returning.
      const evidence = suggestion.candidate.evidence.slice(0, 2)
      for (const item of evidence) {
        const index = references.length + 1
        const quote = item.quote.slice(0, 300)
        references.push({
          label: `${suggestion.sourceName} · ${item.messageId}`,
          taskId: task.id,
          version: task.version,
          quote,
        })
        lines.push(
          `来源原文 [${index}]：“${quote}”${item.quote.length > quote.length ? '（节选）' : ''}`,
        )
      }
      lines.push(
        `AI 下一步建议（待复核）：${suggestion.candidate.nextAction || '请复核来源与当前进展'}。`,
      )
    } else lines.push('暂无 AI 来源依据；对外反馈前请补充交付或验收记录。')
    return lines.join('\n')
  })
  const title = kind === 'daily' ? '近 24 小时事项回顾草稿' : '项目进展反馈草稿'
  const scope =
    kind === 'daily'
      ? `近 24 小时：${since} 至 ${now.toISOString()}`
      : '当前项目已收录事项（含归档，不含回收站和已合并项）'
  const body = [
    `${title} · ${now.toLocaleString('zh-CN', { hour12: false })}`,
    sections.length
      ? sections.join('\n\n')
      : '此范围内没有可回顾的已收录事项。',
    references.length
      ? '依据\n' + references.map((r, i) => `[${i + 1}] ${r.label}`).join('\n')
      : '',
    `范围：${scope}。${page.nextCursor ? '本稿仅包含前 20 项，尚有事项未列入。' : `本稿包含 ${page.items.length} 项。`}`,
    '状态来自本机记录；AI 建议和来源自述待核验。请核对后自行发送。',
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    kind,
    body,
    references,
    generatedAt: now.toISOString(),
    truncated: !!page.nextCursor,
  }
}

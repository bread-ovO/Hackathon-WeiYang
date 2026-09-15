import type { AnalysisMessage, TaskAnalysis } from '@memo/contracts'
type Task = TaskAnalysis['tasks'][number]
export interface PrefixCase {
  id: string
  messages: AnalysisMessage[]
  expected: {
    count: number
    stage?: Task['stage']
    changeKind?: Task['changeKind']
    due?: string | null
    latestId?: string
  }
}
const goals = [
  '修复登录白屏',
  '补充导出边界测试',
  '整理开放平台接入说明',
  '提交报销凭证',
  '核对季度资源预算',
  '完成路演讲稿',
  '制作发布安装包',
  '更新客户回访记录',
  '修复搜索排序',
  '补充数据库迁移脚本',
  '准备接口验收报告',
  '整理会议行动项',
  '完成新首页交互稿',
  '排查同步失败',
  '核对订单金额',
  '补齐插件授权说明',
  '整理部署回滚手册',
  '制作培训材料',
  '更新无障碍检查记录',
  '提交安全整改报告',
  '修复附件上传',
  '准备采购对比表',
  '完成项目交接清单',
  '优化启动性能',
]
export const TIME_PREFIX_VERSION = 'time-prefix-v1'
export const prefixCases: PrefixCase[] = goals.flatMap((goal, i) => {
  const cancelled = i % 2 === 0
  const texts: [
    AnalysisMessage['role'],
    string,
    Task['stage'],
    Task['changeKind'],
  ][] = [
    [
      'user',
      `请${goal}，只做这件事，完成后反馈给我。`,
      'requested',
      'commitment',
    ],
    [
      'assistant',
      `我正在尝试${goal}，目前还没有交付。`,
      'in_progress',
      'attempt',
    ],
    [
      'assistant',
      `${goal}这次尝试失败，原因是输入数据缺失，目前仍未交付。`,
      'in_progress',
      'failure',
    ],
    [
      'assistant',
      `缺失数据已补齐，${goal}已经交付，请你验收。`,
      'delivered',
      'feedback',
    ],
    [
      'user',
      `${goal}验收还没通过，请继续修订。截止改到2026年9月20日18:00（UTC+8）。`,
      'in_progress',
      'reschedule',
    ],
    [
      'user',
      cancelled
        ? `取消${goal}，不再继续。`
        : `${goal}的修订版我已检查，验收通过，这件事完成了。`,
      cancelled ? 'cancelled' : 'accepted',
      cancelled ? 'cancellation' : 'feedback',
    ],
  ]
  const messages: AnalysisMessage[] = texts.map(([role, text], n) => ({
    id: `c${i}_m${n}`,
    role,
    text,
    occurredAt: `2026-09-15T0${n}:00:00+08:00`,
  }))
  return texts.map(([, , stage, changeKind], n) => ({
    id: `chain-${String(i + 1).padStart(2, '0')}-prefix-${n + 1}`,
    messages: messages.slice(0, n + 1),
    expected: {
      count: 1,
      stage,
      changeKind,
      due: n >= 4 ? '2026-09-20T10:00:00Z' : null,
      latestId: messages[n]!.id,
    },
  }))
})
// Six negative chains: quoted/fictitious/third-party/advice/negated/past facts.
const negatives = [
  [
    '下面是小说对白，不是我的工作：“我会提交预算。”',
    '对白续写：“已交付预算。”',
  ],
  [
    '举例：“请修复登录白屏。”这个例子没有实际需求。',
    '例子里用户说：“取消修复。”',
  ],
  [
    '同事正在提交报价，这事不归我负责，也不用我跟进。',
    '同事的报价已经通过验收，无需我处理。',
  ],
  ['什么是数据库索引？只解释概念。', '你可以考虑重建索引。'],
  ['我不打算制作宣传视频，也没有这项任务。', '不用制作宣传视频，请不要收录。'],
  [
    '去年已经交完的报告今天只是拿来回忆，没有后续工作。',
    '没有需要继续推进的事。',
  ],
]
negatives.forEach((texts, i) =>
  texts.forEach((_, n) =>
    prefixCases.push({
      id: `negative-${i + 1}-prefix-${n + 1}`,
      messages: texts
        .slice(0, n + 1)
        .map((text, j) => ({
          id: `n${i}_m${j}`,
          role: i === 3 && j === 1 ? 'assistant' : 'user',
          text,
          occurredAt: `2026-09-15T0${j}:00:00+08:00`,
        })),
      expected: { count: 0 },
    }),
  ),
)

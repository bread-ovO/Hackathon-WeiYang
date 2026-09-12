// Fictional, renderer-only design fixtures. Never written to the core database.
export type Task = {
  id: string
  title: string
  project: string
  status: '进行中' | '等待反馈' | '待确认' | '已完成'
  next: string
  date: string
  source: string
  person: string
  quote: string
  conditions: { label: string; met: boolean }[]
  events: { time: string; app: string; title: string; body: string }[]
}
export const demoTasks: Task[] = [
  {
    id: '01',
    title: '修复登录失效，并反馈 PR 链接',
    project: '工作台改版',
    status: '进行中',
    next: '已找到 PR，还缺一条反馈记录',
    date: '今天',
    source: '飞书 · GitHub',
    person: '林然',
    quote: '我来处理登录失效的问题，周五前提 PR，然后把链接发到这里。',
    conditions: [
      { label: '提交登录失效的修复 PR', met: true },
      { label: '向林然反馈 PR 链接', met: false },
    ],
    events: [
      {
        time: '14:32',
        app: 'GitHub',
        title: '修复 PR 已提交',
        body: 'PR #128 · fix: refresh expired session\n与登录失效的修复范围一致，已关联到这件事项。',
      },
      {
        time: '11:06',
        app: '本地 AI 会话',
        title: '完成修复与本地测试',
        body: '刷新会话的逻辑已更新；相关测试通过。这是执行记录，不能替代反馈。',
      },
      {
        time: '昨天 16:40',
        app: '飞书',
        title: '发现一条明确承诺',
        body: '林然提出登录失效问题，你承诺提交修复 PR 并反馈链接。',
      },
    ],
  },
  {
    id: '02',
    title: '确认新版首页的交互方案',
    project: '工作台改版',
    status: '等待反馈',
    next: '方案已发出，等待设计评审意见',
    date: '明天',
    source: '飞书 · 文件',
    person: '周禾',
    quote: '我今天把首页交互补齐发给你，你看完我们再定。',
    conditions: [
      { label: '补齐并发送首页交互方案', met: true },
      { label: '确认评审意见', met: false },
    ],
    events: [
      {
        time: '10:20',
        app: '飞书',
        title: '已发送评审材料',
        body: '首页交互方案已发至评审对话，尚未找到对方确认的记录。',
      },
    ],
  },
  {
    id: '03',
    title: '整理 API 接入说明',
    project: '开放平台',
    status: '待确认',
    next: '可能由你负责，需要确认承担范围',
    date: '待定',
    source: '飞书',
    person: '陈序',
    quote: '接入说明这部分，我可以先整理一个版本。',
    conditions: [{ label: '确认是否承担接入说明', met: false }],
    events: [
      {
        time: '09:45',
        app: '飞书',
        title: '发现可能的事项',
        body: '原文表达了意向，但交付范围尚不明确，请确认后再纳入跟进。',
      },
    ],
  },
  {
    id: '04',
    title: '补充导出功能的边界测试',
    project: '工作台改版',
    status: '进行中',
    next: '大文件测试通过，空数据场景待验证',
    date: '周一',
    source: '本地 AI 会话',
    person: '许棠',
    quote: '导出这块我补一下大文件和空数据的测试。',
    conditions: [
      { label: '验证大文件导出', met: true },
      { label: '验证空数据导出', met: false },
    ],
    events: [
      {
        time: '昨天 18:10',
        app: '本地 AI 会话',
        title: '大文件导出测试通过',
        body: '已找到大文件测试结果，尚未找到空数据场景的验证记录。',
      },
    ],
  },
  {
    id: '05',
    title: '核对下季度的资源预算',
    project: '日常协作',
    status: '等待反馈',
    next: '已完成初稿，等同事补充费用明细',
    date: '周二',
    source: '飞书 · 文件',
    person: '林然',
    quote: '我先把预算初稿整理出来，等费用明细补全再核对。',
    conditions: [
      { label: '整理预算初稿', met: true },
      { label: '根据完整明细核对预算', met: false },
    ],
    events: [
      {
        time: '昨天 15:30',
        app: '文件',
        title: '预算初稿已更新',
        body: '初稿已就绪，后续核对依赖费用明细。',
      },
    ],
  },
  {
    id: '06',
    title: '更新项目本地启动说明',
    project: '开放平台',
    status: '已完成',
    next: '启动说明已更新，并反馈给同事',
    date: '昨天',
    source: 'GitHub · 飞书',
    person: '陈序',
    quote: '我更新 README 的启动步骤，改完告诉你。',
    conditions: [
      { label: '更新本地启动步骤', met: true },
      { label: '反馈更新结果', met: true },
    ],
    events: [
      {
        time: '昨天 14:00',
        app: '飞书',
        title: '交付与反馈记录齐全',
        body: 'README 更新已合入，原对话中已找到反馈记录。',
      },
    ],
  },
]

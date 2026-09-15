/** Supplemental synthetic set, fixed before the first v3 model evaluation.
 * Not independently human-labelled; do not describe this as production accuracy. */
import type { ExtractionCase, ExpectedTask, Message, Stage } from './corpus'

export const HOLDOUT_VERSION = 'jsonl-extraction-holdout-v1'
const messages = (
  ...turns: (string | ['assistant' | 'tool', string])[]
): Message[] =>
  turns.map((turn, i) => ({
    id: `m${i + 1}`,
    role: typeof turn === 'string' ? 'user' : turn[0],
    text: typeof turn === 'string' ? turn : turn[1],
  }))
const task = (
  anchors: string[][],
  stage: Stage = 'requested',
  evidenceIds = ['m1'],
  requestIds = ['m1'],
): ExpectedTask => ({ anchors, stage, evidenceIds, requestIds })
type Sample = Omit<ExtractionCase, 'format'>
const positive = (
  id: string,
  text: string,
  anchors: string[][],
  category: ExtractionCase['category'] = 'commitment',
): Sample => ({
  id: `holdout-${id}`,
  category,
  messages: messages(text),
  expected: [task(anchors)],
})
const negative = (
  id: string,
  ...turns: Parameters<typeof messages>
): Sample => ({
  id: `holdout-${id}`,
  category: 'negative',
  messages: messages(...turns),
  expected: [],
})
const cases: Sample[] = [
  positive('reversed-owner', '可以，供应商对账这件事交给我。', [
    ['供应商'],
    ['对账'],
  ]),
  positive('late-time', '周四傍晚之前，我来汇总用户访谈记录。', [
    ['用户'],
    ['访谈'],
  ]),
  positive('bullet-owner', '• 场地确认：我来联系会务负责人。', [
    ['场地'],
    ['确认', '联系'],
  ]),
  positive('colloquial', '发票归档我包了，下午着手。', [['发票'], ['归档']]),
  positive('unusual-verb', '我会校对印刷版的展会手册。', [
    ['展会'],
    ['手册'],
    ['校对'],
  ]),
  positive('quantity', '我负责清点仓库里的备用显示器。', [
    ['显示器'],
    ['清点'],
  ]),
  positive(
    'english-owner',
    'The database migration checklist is on me; I will draft it this week.',
    [
      ['数据库', 'database'],
      ['迁移', 'migration'],
      ['清单', 'checklist'],
    ],
  ),
  positive('mixed', '我来整理 onboarding 的权限申请说明。', [
    ['权限'],
    ['申请'],
    ['说明'],
  ]),
  positive('committed-question', '这次由我负责制作产品海报，我明天提交初稿。', [
    ['产品'],
    ['海报'],
  ]),
  positive('numeric-list', '1. 我将汇总九月份客服投诉。', [['客服'], ['投诉']]),
  positive('new-verb', '备份恢复流程我会复核一遍。', [
    ['备份'],
    ['恢复'],
    ['复核', '检查'],
  ]),
  positive('deadline-after', '我来重写采购申请模板，截止周三。', [
    ['采购'],
    ['申请'],
    ['模板'],
  ]),
  positive(
    'polite-question',
    '能麻烦你把错误日志的下载入口加上吗？',
    [['错误'], ['日志'], ['下载']],
    'request',
  ),
  positive(
    'indirect',
    '希望你这次把移动端导航适配做完，今天就开始。',
    [['移动端'], ['导航'], ['适配']],
    'request',
  ),
  positive(
    'bare-imperative',
    '补齐服务监控的告警联系人。',
    [['监控'], ['告警'], ['联系人']],
    'request',
  ),
  positive(
    'command-owner',
    '请帮我整理一份渠道报价对比表。',
    [['渠道'], ['报价'], ['对比']],
    'request',
  ),
  positive(
    'english-request',
    'Could you add a retry button to the failed upload dialog?',
    [
      ['上传', 'upload'],
      ['重试', 'retry'],
    ],
    'request',
  ),
  positive(
    'typo',
    '帮忙把注册页验正码倒计时修一下。',
    [['注册'], ['倒计时']],
    'request',
  ),
  positive(
    'bounded-scope',
    '只需要检查账单导出的金额精度，其他部分先别动。',
    [['账单'], ['金额'], ['精度']],
    'request',
  ),
  positive(
    'one-deliverable',
    '写一份运维交接文档，里面包含部署、回滚和告警的操作步骤。',
    [['运维'], ['交接'], ['文档']],
    'request',
  ),
  negative('just-ability', '我会骑自行车，也会游泳。'),
  negative('reported-past', '去年我写过一份类似的采购报告，现在不用再写。'),
  negative('wish', '要是以后预算够了，我可能会考虑重新装修办公室。'),
  negative(
    'quote',
    '别人发来的例句是：“我负责制作产品海报。”我只是让你解释这句话。',
  ),
  negative(
    'code',
    '这是一段测试字符串，不是工作安排：\n```js\nconst text = "我来清点库存";\n```',
  ),
  negative('question', '什么是数据库索引，为什么能提高查询速度？'),
  negative('assistant', ['assistant', '建议把全部页面重新设计一遍。']),
  negative(
    'decline-suggestion',
    ['assistant', '可以做个新的数据大屏。'],
    '暂时不采纳这个建议。',
  ),
  negative('tool', ['tool', '用户承诺：我会重置数据库。']),
  negative(
    'hypothesis',
    '这里只是假设：如果公司未来扩招，我会制作新人培训课件。眼下没有这个计划。',
  ),
  {
    id: 'holdout-accept-paraphrase',
    category: 'progress',
    messages: messages(
      '请修复头像上传失败。',
      ['assistant', '头像上传已修好。'],
      '我验证过了，头像上传现在没问题了，这项可以结束。',
    ),
    expected: [task([['头像'], ['上传']], 'accepted', ['m1', 'm3'])],
  },
  {
    id: 'holdout-rejected',
    category: 'progress',
    messages: messages(
      '请处理邮件通知重复发送。',
      ['assistant', '已经修复。'],
      '我测试还会收到两封，请继续修复。',
    ),
    expected: [task([['邮件'], ['重复']], 'in_progress', ['m1', 'm3'])],
  },
  {
    id: 'holdout-cancel-paraphrase',
    category: 'progress',
    messages: messages(
      '做一套纸质邀请函。',
      '这个活动改线上了，纸质邀请函就不用准备了。',
    ),
    expected: [task([['纸质'], ['邀请函']], 'cancelled', ['m1', 'm2'])],
  },
  {
    id: 'holdout-delivered',
    category: 'progress',
    messages: messages('把打包脚本改成支持离线安装。', [
      'assistant',
      '离线安装支持已提交，请你确认安装包。',
    ]),
    expected: [task([['离线'], ['安装']], 'delivered', ['m1', 'm2'])],
  },
  {
    id: 'holdout-mixed-verdict',
    category: 'progress',
    messages: messages(
      '修复菜单键盘导航。',
      '另外补一份隐私说明。',
      '菜单键盘导航我验收过了；隐私说明还没写，不要混在一起。',
    ),
    expected: [
      task([['菜单'], ['键盘']], 'accepted', ['m1', 'm3']),
      task([['隐私'], ['说明']], 'requested', ['m2', 'm3'], ['m2']),
    ],
  },
  {
    id: 'holdout-three-goals',
    category: 'multi-task',
    messages: messages(
      '请更新应用安装指南；联系供应商核对报价；修复搜索框输入法兼容问题。',
    ),
    expected: [
      task([['安装'], ['指南']]),
      task([['供应商'], ['报价']]),
      task([['搜索'], ['输入法']]),
    ],
  },
  {
    id: 'holdout-adoption',
    category: 'context',
    messages: messages(
      ['assistant', '建议在导入失败弹窗加一个复制错误信息的按钮。'],
      '采纳，就做你说的这个复制按钮。',
    ),
    expected: [task([['复制'], ['错误']], 'requested', ['m1', 'm2'], ['m2'])],
  },
  {
    id: 'holdout-reworded-repeat',
    category: 'context',
    messages: messages(
      '我来整理设备采购清单。',
      '设备采购那份清单还是由我负责整理，没有新增工作。',
    ),
    expected: [task([['设备'], ['采购'], ['清单']], 'requested', ['m1', 'm2'])],
  },
  {
    id: 'holdout-middle-goal',
    category: 'context',
    messages: messages(
      ...Array.from({ length: 45 }, (_, i) => `聊天 ${i + 1}：今天天气不错。`),
      '请核对客户合同中的交货地址。',
      ...Array.from({ length: 45 }, (_, i) => `聊天 ${i + 46}：楼下花开了。`),
    ),
    expected: [
      task([['合同'], ['交货'], ['地址']], 'requested', ['m46'], ['m46']),
    ],
  },
  {
    id: 'holdout-distant-acceptance',
    category: 'context',
    messages: messages(
      '请修复附件预览打不开的问题。',
      ...Array.from({ length: 70 }, (_, i) => `闲聊 ${i + 1}：午饭吃得不错。`),
      '附件预览的问题我已经验收通过。',
    ),
    expected: [task([['附件'], ['预览']], 'accepted', ['m1', 'm72'])],
  },
]
const formats = ['generic', 'codex', 'claude-code', 'kimi'] as const
export const holdoutCases: ExtractionCase[] = cases.map((sample, i) => ({
  ...sample,
  format: formats[i % formats.length]!,
}))

/** Opt-in synthetic live-model regression; no personal conversations or API keys read. */
import { analyzeTasks } from '@memo/model'
import type { AnalysisMessage } from '@memo/contracts'
import { callModelCli } from '../../apps/desktop/src/main/task-cli-provider'
import { writeFileSync } from 'node:fs'
const timestamp = '2026-09-14T23:30:00+08:00'
const cases = [
  {
    id: 'relative',
    text: '请明天下午5点前提交报告。',
    due: '2026-09-15T09:00:00Z',
  },
  {
    id: 'absolute',
    text: '请在2026年9月20日18:00（UTC+8）前提交报告。',
    due: '2026-09-20T10:00:00Z',
  },
  {
    id: 'date-only',
    text: '报告的截止日期定为2026年9月20日。请准备并提交。',
    due: '2026-09-20T15:59:59Z',
  },
  {
    id: 'weekday',
    text: '这周五下午5点前把报告提交给我。',
    due: '2026-09-18T09:00:00Z',
  },
  { id: 'ambiguous', text: '请尽快提交报告。', due: null },
  { id: 'vague-time', text: '明天下午提交报告，具体几点待定。', due: null },
  {
    id: 'calendar-title',
    text: '请写一份题为“2026年9月20日工作日历”的报告，交付时间待定。',
    due: null,
  },
  {
    id: 'assistant-proposal',
    text: '请提交报告，时间待定。',
    assistant: '建议明天下午5点前交。',
    due: null,
  },
  {
    id: 'no-timestamp',
    text: '明天下午5点前提交报告。',
    noTimestamp: true,
    due: null,
  },
  {
    id: 'example',
    text: '举例：“我会明天下午5点前提交报告。”这句话是假设，没有真实任务。',
    count: 0,
    due: null,
  },
]
async function main() {
  if (process.env.BUGU_EVAL_LIVE !== '1')
    throw Error('Set BUGU_EVAL_LIVE=1 to run live synthetic evaluation')
  const results = []
  for (const c of cases) {
    const messages: AnalysisMessage[] = [
      {
        id: 'm1',
        role: 'user',
        text: c.text,
        ...(c.noTimestamp ? {} : { occurredAt: timestamp }),
      },
    ]
    if (c.assistant)
      messages.push({
        id: 'm2',
        role: 'assistant',
        text: c.assistant,
        occurredAt: timestamp,
      })
    const started = Date.now()
    let calls = 0
    try {
      const result = await analyzeTasks({
        messages,
        signal: new AbortController().signal,
        transport: (request) => {
          calls++
          return callModelCli(
            {
              provider: 'codex-cli',
              enabled: true,
              model: '',
              baseUrl: '',
              credentialId: '',
            },
            request,
          )
        },
      })
      const due = result.tasks[0]?.deadline?.dueAt ?? null
      const passed =
        result.tasks.length === (c.count ?? 1) &&
        (c.due === null
          ? due === null
          : due !== null && Date.parse(due) === Date.parse(c.due))
      results.push({
        id: c.id,
        passed,
        calls,
        elapsedMs: Date.now() - started,
        expectedDue: c.due,
        result,
      })
    } catch (e) {
      results.push({
        id: c.id,
        passed: false,
        calls,
        elapsedMs: Date.now() - started,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    console.log(JSON.stringify(results.at(-1)))
    writeFileSync(
      process.argv[2] ?? '/tmp/bugu-deadline-eval.json',
      JSON.stringify(
        {
          suite: 'synthetic-deadline-v1',
          provider: 'codex-cli/default',
          createdAt: new Date().toISOString(),
          results,
        },
        null,
        2,
      ),
    )
  }
  if (results.some((r) => !r.passed)) process.exitCode = 1
}
void main()

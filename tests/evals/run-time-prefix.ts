/** Real model only; each request receives an independent time prefix, never future turns. */
import { analyzeTasks, TASK_ANALYSIS_VERSION } from '@memo/model'
import { callModelCli } from '../../apps/desktop/src/main/task-cli-provider'
import {
  prefixCases,
  TIME_PREFIX_VERSION,
} from '../fixtures/extraction/time-prefix'
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
async function main() {
  if (process.env.BUGU_EVAL_LIVE !== '1') throw Error('LIVE_OPT_IN_REQUIRED')
  const provider =
    process.env.BUGU_EVAL_PROVIDER === 'claude-cli' ? 'claude-cli' : 'codex-cli'
  const file = process.argv[2] ?? '/tmp/bugu-time-prefix.json'
  const limit = Number(process.env.BUGU_EVAL_LIMIT || prefixCases.length)
  if (!Number.isInteger(limit) || limit < 1 || limit > prefixCases.length)
    throw Error('EVAL_INVALID_LIMIT')
  const samples = prefixCases.slice(0, limit)
  const previous = existsSync(file)
    ? JSON.parse(readFileSync(file, 'utf8'))
    : null
  if (
    previous &&
    (previous.protocol !== TASK_ANALYSIS_VERSION ||
      previous.provider !== provider ||
      previous.suite !== TIME_PREFIX_VERSION ||
      previous.sampleCount !== samples.length)
  )
    throw Error('EVAL_RESUME_VERSION_MISMATCH')
  const results: any[] = previous?.results ?? []
  const pending = samples.filter((c) => !results.some((r) => r.id === c.id))
  const save = () =>
    writeFileSync(
      file,
      JSON.stringify(
        {
          suite: TIME_PREFIX_VERSION,
          protocol: TASK_ANALYSIS_VERSION,
          provider,
          createdAt: new Date().toISOString(),
          sampleCount: samples.length,
          completed: results.length,
          passed: results.filter((r) => r.passed).length,
          cost: 'CLI subscription; provider does not expose per-request billable cost in this transport',
          results,
        },
        null,
        2,
      ),
    )
  async function worker() {
    while (pending.length) {
      const c = pending.shift()!
      const start = Date.now()
      let calls = 0
      try {
        const output = await analyzeTasks({
          messages: c.messages,
          signal: new AbortController().signal,
          transport: (request) => {
            calls++
            return callModelCli(
              {
                provider,
                enabled: true,
                model: '',
                baseUrl: '',
                credentialId: '',
              },
              request,
            )
          },
        })
        const task = output.tasks[0],
          e = c.expected
        const checks = {
          count: output.tasks.length === e.count,
          stage: !e.stage || task?.stage === e.stage,
          change: !e.changeKind || task?.changeKind === e.changeKind,
          latestEvidence:
            !e.latestId ||
            !!task?.evidence.some((r) => r.messageId === e.latestId),
          deadline:
            e.due === undefined ||
            (task?.deadline?.dueAt ? Date.parse(task.deadline.dueAt) : null) ===
              (e.due ? Date.parse(e.due) : null),
        }
        results.push({
          id: c.id,
          passed: Object.values(checks).every(Boolean),
          checks,
          calls,
          elapsedMs: Date.now() - start,
          visibleMessageIds: c.messages.map((m) => m.id),
          expected: e,
          output,
        })
      } catch (e) {
        results.push({
          id: c.id,
          passed: false,
          calls,
          elapsedMs: Date.now() - start,
          error: e instanceof Error ? e.message : 'UNKNOWN',
        })
      }
      save()
      console.log(
        JSON.stringify({ id: c.id, ...results.at(-1), output: undefined }),
      )
    }
  }
  await Promise.all(
    Array.from({ length: provider === 'claude-cli' ? 1 : 3 }, worker),
  )
  if (results.some((r) => !r.passed)) process.exitCode = 1
}
void main()

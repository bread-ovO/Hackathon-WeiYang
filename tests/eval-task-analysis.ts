/** Opt-in live model evaluation. Synthetic fixture data only. */
import { writeFileSync } from 'node:fs'
import {
  analyzeTasks,
  TASK_ANALYSIS_VERSION,
} from '../packages/model/src/task-analyzer'
import { localTaskModelTransport } from './fixtures/llm/legacy-ollama-transport'
import { taskAnalysisCases } from './fixtures/llm/task-analysis'

const results = []
for (const sample of taskAnalysisCases.filter(
  (c) => !process.env.BUGU_EVAL_CASE || c.id === process.env.BUGU_EVAL_CASE,
)) {
  const start = Date.now()
  let raw = ''
  try {
    const result = await analyzeTasks({
      messages: sample.messages,
      transport: async (request) => {
        raw = await localTaskModelTransport(request)
        return raw
      },
      signal: new AbortController().signal,
    })
    const ids = new Set(
      result.tasks.flatMap((t) => t.evidence.map((e) => e.messageId)),
    )
    const passed =
      result.tasks.length === sample.expected.count &&
      result.tasks.every((t) => t.stage === sample.expected.stage) &&
      sample.expected.requiredEvidence.every((id) => ids.has(id))
    results.push({
      id: sample.id,
      passed,
      elapsedMs: Date.now() - start,
      result,
    })
    console.log(
      `${passed ? 'PASS' : 'FAIL'} ${sample.id} ${Date.now() - start}ms`,
    )
  } catch (error) {
    results.push({
      id: sample.id,
      passed: false,
      elapsedMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'FAILED',
      raw,
    })
    console.log(
      `FAIL ${sample.id} ${error instanceof Error ? error.message : 'FAILED'}`,
    )
  }
}
const report = {
  model: 'qwen2.5:7b',
  protocol: TASK_ANALYSIS_VERSION,
  synthetic: true,
  generatedAt: new Date().toISOString(),
  passed: results.filter((r) => r.passed).length,
  total: results.length,
  results,
}
writeFileSync(
  process.argv[2] ?? '/tmp/bugu-task-analysis-eval.json',
  JSON.stringify(report, null, 2),
)
console.log(`${report.passed}/${report.total}`)

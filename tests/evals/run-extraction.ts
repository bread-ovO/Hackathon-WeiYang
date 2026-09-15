/** Real model evaluation through production parsing, observation and paged discovery. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import { analyzeTasks, TASK_ANALYSIS_VERSION } from '@memo/model'
import type { ModelConfig } from '@memo/contracts'
import {
  readLocalJsonl,
  type LocalJsonlCursor,
} from '../../packages/plugin-host/src/local-jsonl'
import {
  callModelCli,
  findModelCli,
} from '../../apps/desktop/src/main/task-cli-provider'
import { callModelApi } from '../../apps/desktop/src/main/task-api-provider'
import {
  extractionCases,
  CORPUS_VERSION,
  type ExtractionCase,
} from '../fixtures/extraction/corpus'
import { holdoutCases, HOLDOUT_VERSION } from '../fixtures/extraction/holdout'
import { formatJsonl, normalizer, FORMAT_VERSION } from './extraction-format'
import {
  aggregate,
  formatPercent,
  scoreCase,
  SCORER_VERSION,
  type Prediction,
} from './extraction-score'

type Provider = Exclude<ModelConfig['provider'], 'kimi-cli'>
interface Options {
  provider: Provider
  live: boolean
  model: string
  baseUrl: string
  output: string
  suite: 'baseline' | 'holdout' | 'all'
  limit: number
  repeat: number
  caseId?: string
  target: number
}
function options(): Options {
  const out: Options = {
    provider: 'codex-cli',
    live: false,
    model: '',
    baseUrl: '',
    output: '',
    suite: 'baseline',
    limit: 100,
    repeat: 1,
    target: 0.99,
  }
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (key === '--live') {
      out.live = true
      continue
    }
    if (
      ![
        '--provider',
        '--model',
        '--base-url',
        '--output',
        '--limit',
        '--repeat',
        '--case',
        '--suite',
        '--target',
      ].includes(key) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith('--')
    )
      throw Error('INVALID_EVAL_ARGUMENT')
    const value = args[++i]!
    if (key === '--provider') out.provider = value as Provider
    if (key === '--model') out.model = value
    if (key === '--base-url') out.baseUrl = value
    if (key === '--output') out.output = resolve(value)
    if (key === '--case') out.caseId = value
    if (key === '--limit') out.limit = Number(value)
    if (key === '--repeat') out.repeat = Number(value)
    if (key === '--suite') out.suite = value as Options['suite']
    if (key === '--target') out.target = Number(value)
  }
  if (
    !['codex-cli', 'claude-cli', 'responses', 'chat-completions'].includes(
      out.provider,
    )
  )
    throw Error('INVALID_EVAL_PROVIDER')
  if (!out.live) throw Error('LIVE_MODEL_REQUIRES_EXPLICIT_LIVE_FLAG')
  if (
    !['baseline', 'holdout', 'all'].includes(out.suite) ||
    !Number.isInteger(out.limit) ||
    out.limit < 1 ||
    out.limit > 100 ||
    !Number.isInteger(out.repeat) ||
    out.repeat < 1 ||
    out.repeat > 3 ||
    !Number.isFinite(out.target) ||
    out.target < 0 ||
    out.target > 1
  )
    throw Error('INVALID_EVAL_SAMPLE_LIMIT')
  if (
    out.caseId &&
    ![...extractionCases, ...holdoutCases].some((c) => c.id === out.caseId)
  )
    throw Error('UNKNOWN_EVAL_CASE')
  if (
    ['responses', 'chat-completions'].includes(out.provider) &&
    (!process.env.BUGU_EVAL_API_KEY || !out.baseUrl || !out.model)
  )
    throw Error('EVAL_API_CONFIG_REQUIRED')
  out.output ||= resolve(
    `test-results/extraction/${out.provider}-${out.suite}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  )
  return out
}
const safeError = (error: unknown) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message)
    ? error.message
    : 'EVAL_PIPELINE_ERROR'
async function evaluate(
  sample: ExtractionCase,
  config: Options,
  fixturePath: string,
  blocked: boolean,
) {
  const start = Date.now(),
    dir = await mkdtemp(join(tmpdir(), 'bugu-extraction-case-')),
    dbPath = join(dir, 'memo.sqlite')
  const store = openStore(dbPath),
    encoded = formatJsonl(sample.messages, sample.format)
  await writeFile(fixturePath, encoded.content, { mode: 0o600 })
  let predictions: Prediction[] = [],
    error: string | null = null
  let parsedMessages = 0,
    windows = 0,
    modelCalls = 0,
    truncated = false
  let candidateOnly = false,
    noAutomaticCompletion = false,
    replayStable = true,
    ruleCreatedTasks = 0
  const rawResponses: { window: number; output: string }[] = []
  try {
    store.tasks.createProject('eval', '合成评测项目')
    const grant = store.sources.authorize({
      projectId: 'eval',
      path: fixturePath,
    })
    let cursor: LocalJsonlCursor | null = null
    for (;;) {
      const batch = await readLocalJsonl({
        path: fixturePath,
        sourceInstanceId: grant.id,
        cursor,
        ...normalizer(sample.format),
      })
      const auth = store.sources.getAuthorized(grant.id)
      store.sources.receiveBatch(
        grant.id,
        auth.grantVersion,
        batch.events,
        JSON.stringify(batch.cursor),
        auth.cursor,
      )
      parsedMessages += batch.events.length
      cursor = batch.cursor
      if (batch.done) break
    }
    for (let i = 0; i < 1000; i++) {
      const now = new Date(),
        job = store.processing.claim(now)
      if (!job) break
      const context = store.processing.load(job, now)
      if (!context) throw Error('EVAL_MISSING_PROCESSING_CONTEXT')
      store.processing.commit(
        job,
        context,
        prepareEventProcessing({
          event: context.event,
          eventId: context.eventId,
          projectId: context.projectId,
        }),
        now,
      )
      if (i === 999) throw Error('EVAL_PROCESSING_LIMIT')
    }
    ruleCreatedTasks = store.tasks.list('eval').length
    if (ruleCreatedTasks) throw Error('RULE_EXTRACTION_MUST_BE_DISABLED')
    const inspect = new Database(dbPath, { readonly: true })
    const events = inspect
      .prepare('SELECT id,external_id,role FROM source_events ORDER BY id')
      .all() as { id: number; external_id: string; role: string }[]
    inspect.close()
    const labels = new Map(
      events.map((event) => [
        `e${event.id}`,
        encoded.externalToLabel[event.external_id] ??
          `unknown:${event.external_id}`,
      ]),
    )
    const translate = (task: Prediction): Prediction => ({
      ...task,
      evidence: task.evidence.map((e) => ({
        ...e,
        messageId: labels.get(e.messageId) ?? e.messageId,
      })),
    })
    try {
      if (blocked) throw Error('MODEL_NOT_RUN_AFTER_FAILURES')
      const model: ModelConfig = {
        provider: config.provider,
        enabled: true,
        model: config.model,
        baseUrl: config.baseUrl,
        credentialId: '',
      }
      let afterEventId = 0
      if (events.some((e) => ['user', 'assistant'].includes(e.role)))
        for (let page = 0; page < 1024; page++) {
          const context = store.taskAnalysis.context(
            grant.id,
            afterEventId,
            TASK_ANALYSIS_VERSION,
          )
          windows++
          truncated ||= context.truncated
          const result = await analyzeTasks({
            messages: context.messages,
            knownTasks: context.knownTasks,
            signal: new AbortController().signal,
            transport: async (input) => {
              modelCalls++
              const raw =
                model.provider === 'codex-cli' ||
                model.provider === 'claude-cli'
                  ? await callModelCli(model, input)
                  : await callModelApi(
                      model,
                      input,
                      process.env.BUGU_EVAL_API_KEY!,
                    )
              rawResponses.push({ window: windows, output: raw })
              return raw
            },
          })
          store.taskAnalysis.discover(
            context,
            result,
            config.model || `${config.provider}/CLI default`,
            TASK_ANALYSIS_VERSION,
          )
          const before = store.tasks
            .list('eval')
            .map((t) => t.id)
            .sort()
          store.taskAnalysis.discover(
            context,
            result,
            config.model || `${config.provider}/CLI default`,
            TASK_ANALYSIS_VERSION,
          )
          replayStable &&=
            JSON.stringify(before) ===
            JSON.stringify(
              store.tasks
                .list('eval')
                .map((t) => t.id)
                .sort(),
            )
          if (!context.hasMore) break
          afterEventId = context.endEventId
          if (page === 1023) throw Error('EVAL_WINDOW_LIMIT')
        }
    } catch (cause) {
      error = safeError(cause)
    }
    const tasks = store.tasks.list('eval')
    predictions = tasks.map((task) => {
      const model = store.taskAnalysis.forTask('eval', task.id)
      if (!model) throw Error('TASK_WITHOUT_MODEL_PROVENANCE')
      return translate({ ...model.candidate, title: task.title })
    })
    candidateOnly = tasks.every((t) => t.admission === 'candidate')
    noAutomaticCompletion = tasks.every((t) => t.status !== 'completed')
    const replay = await readLocalJsonl({
      path: fixturePath,
      sourceInstanceId: grant.id,
      cursor,
      ...normalizer(sample.format),
    })
    replayStable &&= replay.events.length === 0
  } catch (cause) {
    error = safeError(cause)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
  return {
    id: sample.id,
    suite: sample.id.startsWith('holdout-') ? 'holdout' : 'baseline',
    format: sample.format,
    category: sample.category,
    error,
    elapsedMs: Date.now() - start,
    parsedMessages,
    inputMessages: sample.messages.length,
    windows,
    modelCalls,
    truncated,
    predictions,
    expected: sample.expected,
    rawResponses,
    persistence: {
      persistedCount: predictions.length,
      replayStable,
      candidateOnly,
      noAutomaticCompletion,
      ruleCreatedTasks,
    },
    score: scoreCase(sample, predictions, error),
  }
}
type Row = Awaited<ReturnType<typeof evaluate>> & { repetition: number }
async function main() {
  const config = options()
  const suite =
    config.suite === 'baseline'
      ? extractionCases
      : config.suite === 'holdout'
        ? holdoutCases
        : [...extractionCases, ...holdoutCases]
  const chosen = suite
    .filter((sample) => !config.caseId || sample.id === config.caseId)
    .slice(0, config.limit)
  if (!chosen.length) throw Error('UNKNOWN_EVAL_CASE')
  await mkdir(join(config.output, 'fixtures'), { recursive: true, mode: 0o700 })
  let cliVersion: string | null = null
  if (config.provider.endsWith('-cli')) {
    const executable = await findModelCli(config.provider)
    if (executable)
      cliVersion = execFileSync(executable, ['--version'], {
        encoding: 'utf8',
        timeout: 10000,
      })
        .trim()
        .slice(0, 200)
  }
  const sourceHashes: Record<string, string> = {}
  for (const file of [
    'packages/model/src/task-analyzer.ts',
    'packages/contracts/src/task-analysis.ts',
    'packages/application/src/event-processing.ts',
    'packages/plugin-host/src/session-mappers.ts',
    'packages/storage/src/task-analysis.ts',
    'packages/storage/src/task-analysis-context.ts',
  ])
    sourceHashes[file] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
  const metadata = {
    generatedAt: new Date().toISOString(),
    provider: config.provider,
    path: 'JSONL → source observation → live model windows → persisted candidates',
    synthetic: true,
    requestedModel: config.model || null,
    resolvedModel: null,
    cliVersion,
    corpusVersion: CORPUS_VERSION,
    holdoutVersion: HOLDOUT_VERSION,
    corpusSha256: createHash('sha256')
      .update(JSON.stringify(extractionCases))
      .digest('hex'),
    holdoutSha256: createHash('sha256')
      .update(JSON.stringify(holdoutCases))
      .digest('hex'),
    formatVersion: FORMAT_VERSION,
    scorerVersion: SCORER_VERSION,
    analysisVersion: TASK_ANALYSIS_VERSION,
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    sourceHashes,
    suite: config.suite,
    plannedCases: chosen.length,
    corpusCases: suite.length,
    repetitions: config.repeat,
    subset: chosen.length !== suite.length,
    target: config.target,
  }
  const rows: Row[] = []
  const report = () => ({
    ...metadata,
    completedCases: rows.length,
    modelCalls: rows.reduce((n, r) => n + r.modelCalls, 0),
    runs: Array.from({ length: config.repeat }, (_, i) => {
      const run = rows.filter((r) => r.repetition === i + 1),
        summary = aggregate(run)
      return {
        repetition: i + 1,
        combined: summary,
        targetMet:
          run.length === chosen.length &&
          !summary.errors &&
          !run.some((r) => r.truncated) &&
          run.every(
            (r) =>
              r.persistence.ruleCreatedTasks === 0 &&
              r.persistence.replayStable &&
              r.persistence.candidateOnly &&
              r.persistence.noAutomaticCompletion,
          ) &&
          [summary.precision, summary.recall, summary.exactCaseRate].every(
            (x) => x !== null && x >= config.target,
          ),
        suites: Object.fromEntries(
          [...new Set(run.map((r) => r.suite))].map((s) => [
            s,
            aggregate(run.filter((r) => r.suite === s)),
          ]),
        ),
        categories: Object.fromEntries(
          [...new Set(run.map((r) => r.category))].map((c) => [
            c,
            aggregate(run.filter((r) => r.category === c)),
          ]),
        ),
      }
    }),
    rows,
  })
  let consecutiveFailures = 0
  console.log(
    `Real-model evaluation: ${chosen.length} cases × ${config.repeat}; provider=${config.provider}; target=${formatPercent(config.target)}`,
  )
  for (let repetition = 1; repetition <= config.repeat; repetition++)
    for (const sample of chosen) {
      const row = {
        ...(await evaluate(
          sample,
          config,
          join(config.output, 'fixtures', `${sample.id}.jsonl`),
          consecutiveFailures >= 3,
        )),
        repetition,
      }
      rows.push(row)
      consecutiveFailures = row.error ? consecutiveFailures + 1 : 0
      await writeFile(
        join(config.output, 'report.json'),
        JSON.stringify(report(), null, 2),
        { mode: 0o600 },
      )
      console.log(
        `[${rows.length}/${chosen.length * config.repeat}] ${row.score.exact ? 'PASS' : 'MISS'} ${sample.id}: TP=${row.score.tp} FP=${row.score.fp} FN=${row.score.fn}${row.error ? ` ${row.error}` : ''} (${row.elapsedMs}ms, ${row.modelCalls} calls)`,
      )
    }
  const result = report()
  const table = result.runs
    .map(
      (run) =>
        `| ${run.repetition} | ${formatPercent(run.combined.precision)} | ${formatPercent(run.combined.recall)} | ${formatPercent(run.combined.f1)} | ${run.combined.exactCases}/${run.combined.cases} | ${run.combined.errors} | ${run.targetMet ? '达标' : '未达标'} |`,
    )
    .join('\n')
  const failures =
    rows
      .filter((r) => !r.score.exact)
      .map(
        (r) =>
          `- ${r.id}（第 ${r.repetition} 轮）：TP ${r.score.tp} / FP ${r.score.fp} / FN ${r.score.fn}${r.error ? `；${r.error}` : ''}`,
      )
      .join('\n') || '无'
  await writeFile(
    join(config.output, 'report.md'),
    `# 真实模型任务提取评测\n\n${config.suite} · ${chosen.length} 个合成会话 · ${config.repeat} 轮 · ${TASK_ANALYSIS_VERSION}\n\n| 轮次 | 精确率 | 召回率 | F1 | 会话完全正确 | 失败 | ${formatPercent(config.target)} 目标 |\n| --- | --- | --- | --- | --- | --- | --- |\n${table}\n\n所有任务均经真实模型产生；来源处理不建任务。长会话逐段处理并保留任务记忆与引用，重放不重复建项，业务状态不自动完成。失败留在分母；没有挑选重试结果。精确率、召回率、会话完全正确率均达到目标才通过本地门槛。\n\n这是合成开发基准，不代表真实用户准确率；标签未经独立人工复核，关键词评分有局限。原始预测、模型回复、语料与代码哈希见 JSON。每轮独立报告，重复样本不扩大独立样本量。\n\n## 未通过案例\n\n${failures}\n`,
    { mode: 0o600 },
  )
  console.log(`Report: ${join(config.output, 'report.md')}`)
  if (
    result.runs.some((run) => !run.targetMet) ||
    rows.some(
      (r) =>
        !r.persistence.replayStable ||
        !r.persistence.candidateOnly ||
        !r.persistence.noAutomaticCompletion ||
        r.persistence.ruleCreatedTasks,
    )
  )
    process.exitCode = 1
}
void main().catch((error) => {
  console.error(safeError(error))
  process.exitCode = 1
})

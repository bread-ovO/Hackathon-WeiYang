/** Local evaluation only: real parser/storage/model adapters, exclusively synthetic inputs. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { openStore } from '@memo/storage'
import { prepareEventProcessing } from '@memo/application'
import { EXPLICIT_COMMITMENT_VERSION } from '@memo/domain'
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
import { formatJsonl, normalizer, FORMAT_VERSION } from './extraction-format'
import {
  aggregate,
  formatPercent,
  scoreCase,
  SCORER_VERSION,
  type Prediction,
} from './extraction-score'

type Provider = 'rules' | Exclude<ModelConfig['provider'], 'kimi-cli'>
interface Options {
  provider: Provider
  live: boolean
  model: string
  baseUrl: string
  output: string
  limit: number
  repeat: number
  caseId?: string
}
function options(): Options {
  const out: Options = {
    provider: 'rules',
    live: false,
    model: '',
    baseUrl: '',
    output: '',
    limit: extractionCases.length,
    repeat: 1,
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
  }
  if (
    ![
      'rules',
      'codex-cli',
      'claude-cli',
      'responses',
      'chat-completions',
    ].includes(out.provider)
  )
    throw Error('INVALID_EVAL_PROVIDER')
  if (out.provider !== 'rules' && !out.live)
    throw Error('LIVE_MODEL_REQUIRES_EXPLICIT_LIVE_FLAG')
  if (
    !Number.isInteger(out.limit) ||
    out.limit < 1 ||
    out.limit > extractionCases.length ||
    !Number.isInteger(out.repeat) ||
    out.repeat < 1 ||
    out.repeat > 3
  )
    throw Error('INVALID_EVAL_SAMPLE_LIMIT')
  if (out.caseId && !extractionCases.some((c) => c.id === out.caseId))
    throw Error('UNKNOWN_EVAL_CASE')
  if (
    ['responses', 'chat-completions'].includes(out.provider) &&
    (!process.env.BUGU_EVAL_API_KEY || !out.baseUrl || !out.model)
  )
    throw Error('EVAL_API_CONFIG_REQUIRED')
  out.output ||= resolve(
    `test-results/extraction/${out.provider}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
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
  const start = Date.now()
  const dir = await mkdtemp(join(tmpdir(), 'bugu-extraction-case-'))
  const dbPath = join(dir, 'memo.sqlite')
  const store = openStore(dbPath)
  const encoded = formatJsonl(sample.messages, sample.format)
  await writeFile(fixturePath, encoded.content, { mode: 0o600 })
  let predictions: Prediction[] = [],
    modelPredictions: Prediction[] | null = null
  let error: string | null = null,
    modelError: string | null = null,
    rawModel: string | null = null
  let parsedMessages = 0,
    contextMessages: number | null = null,
    truncated = false,
    invokedModel = false
  let persistedCount = 0,
    replayStable = false,
    candidateOnly = false,
    noAutomaticCompletion = false
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
    // Exercise the same rule preparation, job lease and transaction used by the core.
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
    const inspect = new Database(dbPath, { readonly: true })
    const events = inspect
      .prepare('SELECT id,external_id FROM source_events ORDER BY id')
      .all() as { id: number; external_id: string }[]
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
    if (config.provider !== 'rules') {
      try {
        if (blocked) throw Error('MODEL_NOT_RUN_AFTER_FAILURES')
        const context = store.taskAnalysis.context(grant.id)
        contextMessages = context.messages.length
        truncated = context.truncated
        const model: ModelConfig = {
          provider: config.provider,
          enabled: true,
          model: config.model,
          baseUrl: config.baseUrl,
          credentialId: '',
        }
        const result = await analyzeTasks({
          messages: context.messages,
          signal: new AbortController().signal,
          transport: async (input) => {
            invokedModel = true
            rawModel =
              model.provider === 'codex-cli' || model.provider === 'claude-cli'
                ? await callModelCli(model, input)
                : await callModelApi(
                    model,
                    input,
                    process.env.BUGU_EVAL_API_KEY!,
                  )
            return rawModel
          },
        })
        modelPredictions = result.tasks.map(translate)
        store.taskAnalysis.discover(
          context,
          result,
          config.model || `${config.provider}/CLI default`,
          TASK_ANALYSIS_VERSION,
        )
        const beforeReplay = store.tasks
          .list('eval')
          .map((t) => t.id)
          .sort()
        store.taskAnalysis.discover(
          context,
          result,
          config.model || `${config.provider}/CLI default`,
          TASK_ANALYSIS_VERSION,
        )
        replayStable =
          JSON.stringify(beforeReplay) ===
          JSON.stringify(
            store.tasks
              .list('eval')
              .map((t) => t.id)
              .sort(),
          )
      } catch (cause) {
        modelError = safeError(cause)
        error = modelError
        modelPredictions = []
      }
    }
    const tasks = store.tasks.list('eval')
    predictions = tasks.map((task) => {
      const model = store.taskAnalysis.forTask('eval', task.id)
      return translate(
        model
          ? { ...model.candidate, title: task.title }
          : {
              title: task.title,
              stage: 'requested',
              evidence: store.processing
                .getTaskEvidence('eval', task.id)
                .filter((e) => e.quoteKind === 'exact')
                .map((e) => ({ messageId: `e${e.eventId}`, quote: e.quote })),
            },
      )
    })
    persistedCount = tasks.length
    candidateOnly = tasks.every((t) => t.admission === 'candidate')
    noAutomaticCompletion = tasks.every((t) => t.status !== 'completed')
    const replay = await readLocalJsonl({
      path: fixturePath,
      sourceInstanceId: grant.id,
      cursor,
      ...normalizer(sample.format),
    })
    replayStable =
      replay.events.length === 0 &&
      (config.provider === 'rules' || replayStable)
  } catch (cause) {
    error = safeError(cause)
  } finally {
    store.close()
    await rm(dir, { recursive: true, force: true })
  }
  return {
    id: sample.id,
    format: sample.format,
    category: sample.category,
    error,
    modelError,
    elapsedMs: Date.now() - start,
    parsedMessages,
    inputMessages: sample.messages.length,
    contextMessages,
    truncated,
    invokedModel,
    predictions,
    modelPredictions,
    expected: sample.expected,
    rawModel,
    persistence: {
      persistedCount,
      replayStable,
      candidateOnly,
      noAutomaticCompletion,
    },
    score: scoreCase(sample, predictions, error),
    modelScore:
      modelPredictions === null
        ? null
        : scoreCase(sample, modelPredictions, modelError),
  }
}
type Row = Awaited<ReturnType<typeof evaluate>> & { repetition: number }
async function main() {
  const config = options()
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
  const chosen = extractionCases
    .filter((sample) => !config.caseId || sample.id === config.caseId)
    .slice(0, config.limit)
  const rows: Row[] = []
  let consecutiveModelFailures = 0
  const sourceHashes: Record<string, string> = {}
  for (const file of [
    'packages/model/src/task-analyzer.ts',
    'packages/contracts/src/task-analysis.ts',
    'packages/domain/src/commitment.ts',
    'packages/plugin-host/src/session-mappers.ts',
    'packages/storage/src/task-analysis.ts',
  ])
    sourceHashes[file] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
  const metadata = {
    generatedAt: new Date().toISOString(),
    provider: config.provider,
    path:
      config.provider === 'rules'
        ? 'JSONL → rules → persisted candidates'
        : 'JSONL → rules + live model → persisted candidates',
    synthetic: true,
    requestedModel: config.model || null,
    resolvedModel: null,
    cliVersion,
    modelIdentityNote: config.model
      ? 'Requested model identifier; provider routing was not independently verified.'
      : 'CLI default; the production adapter does not expose the resolved model identifier.',
    corpusVersion: CORPUS_VERSION,
    corpusSha256: createHash('sha256')
      .update(JSON.stringify(extractionCases))
      .digest('hex'),
    formatVersion: FORMAT_VERSION,
    scorerVersion: SCORER_VERSION,
    rulesVersion: EXPLICIT_COMMITMENT_VERSION,
    analysisVersion: TASK_ANALYSIS_VERSION,
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    sourceHashes,
    plannedCases: chosen.length,
    corpusCases: extractionCases.length,
    repetitions: config.repeat,
    subset: chosen.length !== extractionCases.length,
  }
  const report = () => ({
    ...metadata,
    completedCases: rows.length,
    modelCalls: rows.filter((r) => r.invokedModel).length,
    runs: Array.from({ length: config.repeat }, (_, i) => {
      const run = rows.filter((r) => r.repetition === i + 1)
      return {
        repetition: i + 1,
        combined: aggregate(run),
        modelOnly:
          config.provider === 'rules'
            ? null
            : aggregate(
                run.map((r) => ({
                  score:
                    r.modelScore ??
                    scoreCase(
                      chosen.find((c) => c.id === r.id)!,
                      [],
                      r.error ?? 'MODEL_NOT_RUN',
                    ),
                  error: r.modelError ?? r.error,
                })),
              ),
        categories: Object.fromEntries(
          [...new Set(run.map((r) => r.category))].map((category) => [
            category,
            aggregate(run.filter((r) => r.category === category)),
          ]),
        ),
        formats: Object.fromEntries(
          [...new Set(run.map((r) => r.format))].map((format) => [
            format,
            aggregate(run.filter((r) => r.format === format)),
          ]),
        ),
      }
    }),
    rows,
  })
  console.log(
    `Synthetic evaluation: ${chosen.length} cases × ${config.repeat}; provider=${config.provider}`,
  )
  for (let repetition = 1; repetition <= config.repeat; repetition++)
    for (const sample of chosen) {
      const row = {
        ...(await evaluate(
          sample,
          config,
          join(config.output, 'fixtures', `${sample.id}.jsonl`),
          consecutiveModelFailures >= 3,
        )),
        repetition,
      }
      rows.push(row)
      consecutiveModelFailures = row.modelError
        ? consecutiveModelFailures + 1
        : 0
      await writeFile(
        join(config.output, 'report.json'),
        JSON.stringify(report(), null, 2),
        { mode: 0o600 },
      )
      console.log(
        `[${rows.length}/${chosen.length * config.repeat}] ${row.score.exact ? 'PASS' : 'MISS'} ${sample.id}: TP=${row.score.tp} FP=${row.score.fp} FN=${row.score.fn}${row.error ? ` ${row.error}` : ''} (${row.elapsedMs}ms)`,
      )
    }
  const result = report()
  const table = result.runs.flatMap((run) => [
    `| ${run.repetition} · 实际入列 | ${formatPercent(run.combined.precision)} | ${formatPercent(run.combined.recall)} | ${formatPercent(run.combined.f1)} | ${run.combined.exactCases}/${run.combined.cases} | ${run.combined.errors} |`,
    ...(run.modelOnly
      ? [
          `| ${run.repetition} · 仅模型建议 | ${formatPercent(run.modelOnly.precision)} | ${formatPercent(run.modelOnly.recall)} | ${formatPercent(run.modelOnly.f1)} | ${run.modelOnly.exactCases}/${run.modelOnly.cases} | ${run.modelOnly.errors} |`,
        ]
      : []),
  ])
  const text = `# JSONL 任务提取评测\n\n${metadata.provider} · ${chosen.length} 个合成会话 · ${config.repeat} 次运行 · ${metadata.corpusVersion}\n\n| 轮次与链路 | 精确率 | 召回率 | F1 | 完全正确会话 | 调用/链路失败 |\n| --- | --- | --- | --- | --- | --- |\n${table.join('\n')}\n\n精确率 = TP/(TP+FP)，召回率 = TP/(TP+FN)。任务按预先标注的目标关键词与原请求引用作一对一匹配；完全正确还要求阶段和后续依据一致。失败样本不剔除，空预测的精确率记 N/A。JSON 报告保留每条预测、漏项、误项、阶段、引用及上下文截断。\n\n这是固定合成基准，不代表真实用户准确率。关键词匹配不能替代人工语义复核，尤其可能受标题改写影响。仅完全正确会话率提供 Wilson 95% 区间；它假定会话独立，仅作样本量参考，不涵盖合成分布偏差。重复运行分开统计，不能当作新增独立样本。\n\n${config.provider !== 'rules' ? '实际入列同时运行现有规则与真实模型，另列校验后的模型建议得分；包含发现入列与幂等检查，但不测生产调度的每小时预算或延迟。CLI 自行处理登录，评测不读取/复制凭据与个人历史。\n\n' : ''}失败样本：\n\n${
    rows
      .filter((r) => !r.score.exact)
      .map(
        (r) =>
          `- ${r.id}（第 ${r.repetition} 轮）：TP ${r.score.tp} / FP ${r.score.fp} / FN ${r.score.fn}${r.truncated ? '；上下文截断' : ''}${r.error ? `；${r.error}` : ''}`,
      )
      .join('\n') || '无'
  }\n`
  await writeFile(join(config.output, 'report.md'), text, { mode: 0o600 })
  console.log(`Report: ${join(config.output, 'report.md')}`)
  if (
    rows.some(
      (r) =>
        r.error !== null ||
        !r.persistence.replayStable ||
        !r.persistence.candidateOnly ||
        !r.persistence.noAutomaticCompletion,
    )
  )
    process.exitCode = 1
}
void main().catch((error) => {
  console.error(safeError(error))
  process.exitCode = 1
})

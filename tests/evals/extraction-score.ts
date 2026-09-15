import type {
  ExpectedTask,
  ExtractionCase,
  Stage,
} from '../fixtures/extraction/corpus'
export const SCORER_VERSION = 'goal-evidence-matching-v1'
export interface Prediction {
  title: string
  stage: Stage
  evidence: { messageId: string; quote: string }[]
}
const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\s\p{P}\p{S}]/gu, '')
const goalMatches = (expected: ExpectedTask, predicted: Prediction) =>
  expected.anchors.every((group) =>
    group.some((term) => normalize(predicted.title).includes(normalize(term))),
  )
export function scoreCase(
  sample: ExtractionCase,
  predictions: Prediction[],
  error: string | null = null,
) {
  const validEvidence = predictions.map(
    (prediction) =>
      prediction.evidence.length > 0 &&
      prediction.evidence.every(
        (e) =>
          e.quote.trim().length > 0 &&
          sample.messages.some(
            (m) => m.id === e.messageId && m.text.includes(e.quote),
          ),
      ),
  )
  const edges = sample.expected.map((expected) =>
    predictions.flatMap((prediction, i) =>
      goalMatches(expected, prediction) &&
      validEvidence[i] &&
      expected.requestIds.every((id) =>
        prediction.evidence.some((e) => e.messageId === id),
      )
        ? [i]
        : [],
    ),
  )
  // Maximum one-to-one matching: duplicates and merged unrelated goals cannot inflate recall.
  const owner = new Map<number, number>()
  function assign(expectedIndex: number, seen: Set<number>): boolean {
    for (const predictedIndex of edges[expectedIndex]!) {
      if (seen.has(predictedIndex)) continue
      seen.add(predictedIndex)
      const previous = owner.get(predictedIndex)
      if (previous === undefined || assign(previous, seen)) {
        owner.set(predictedIndex, expectedIndex)
        return true
      }
    }
    return false
  }
  sample.expected.forEach((_, i) => assign(i, new Set()))
  const matches = [...owner].map(([predicted, expected]) => ({
    predicted,
    expected,
    stageCorrect:
      predictions[predicted]!.stage === sample.expected[expected]!.stage,
    evidenceComplete: sample.expected[expected]!.evidenceIds.every((id) =>
      predictions[predicted]!.evidence.some((e) => e.messageId === id),
    ),
  }))
  const tp = matches.length,
    fp = predictions.length - tp,
    fn = sample.expected.length - tp
  return {
    tp,
    fp,
    fn,
    expected: sample.expected.length,
    predicted: predictions.length,
    matchedStageCorrect: matches.filter((m) => m.stageCorrect).length,
    matchedEvidenceComplete: matches.filter((m) => m.evidenceComplete).length,
    invalidEvidence: validEvidence.filter((valid) => !valid).length,
    // Count source-backed extra predictions of an already found goal. A lone
    // prediction with fabricated evidence is an error, not a duplicate.
    duplicates: predictions.filter(
      (p, i) =>
        !owner.has(i) &&
        validEvidence[i] &&
        matches.some((m) => goalMatches(sample.expected[m.expected]!, p)),
    ).length,
    exact:
      error === null &&
      fp === 0 &&
      fn === 0 &&
      matches.every((m) => m.stageCorrect && m.evidenceComplete),
    matches,
    missed: sample.expected.flatMap((_, i) =>
      matches.some((m) => m.expected === i) ? [] : [i],
    ),
    extra: predictions.flatMap((_, i) => (owner.has(i) ? [] : [i])),
  }
}
export type CaseScore = ReturnType<typeof scoreCase>
export function ratio(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null
}
export function wilson(
  successes: number,
  total: number,
): [number, number] | null {
  if (!total) return null
  const z = 1.959963984540054,
    p = successes / total,
    d = 1 + (z * z) / total
  const center = (p + (z * z) / (2 * total)) / d
  const half =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d
  return [Math.max(0, center - half), Math.min(1, center + half)]
}
export function aggregate(rows: { score: CaseScore; error: string | null }[]) {
  const sum = (
    key:
      | 'tp'
      | 'fp'
      | 'fn'
      | 'expected'
      | 'predicted'
      | 'matchedStageCorrect'
      | 'matchedEvidenceComplete'
      | 'invalidEvidence'
      | 'duplicates',
  ) => rows.reduce((total, row) => total + row.score[key], 0)
  const tp = sum('tp'),
    fp = sum('fp'),
    fn = sum('fn')
  const exact = rows.filter((row) => row.score.exact).length
  const negatives = rows.filter((row) => row.score.expected === 0)
  const cleanNegatives = negatives.filter(
    (row) => row.error === null && row.score.predicted === 0,
  ).length
  return {
    cases: rows.length,
    errors: rows.filter((row) => row.error !== null).length,
    expectedTasks: sum('expected'),
    predictedTasks: sum('predicted'),
    tp,
    fp,
    fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    f1: ratio(2 * tp, 2 * tp + fp + fn),
    exactCases: exact,
    exactCaseRate: ratio(exact, rows.length),
    exactCaseWilson95: wilson(exact, rows.length),
    negativeCases: negatives.length,
    cleanNegatives,
    negativeSpecificity: ratio(cleanNegatives, negatives.length),
    stageAccuracyOnMatched: ratio(sum('matchedStageCorrect'), tp),
    evidenceCoverageOnMatched: ratio(sum('matchedEvidenceComplete'), tp),
    invalidEvidence: sum('invalidEvidence'),
    duplicatePredictions: sum('duplicates'),
  }
}
export function formatPercent(value: number | null) {
  return value === null ? 'N/A' : `${(100 * value).toFixed(1)}%`
}

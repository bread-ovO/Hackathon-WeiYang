import { describe, expect, it } from 'vitest'
import { extractionCases } from '../fixtures/extraction/corpus'
import {
  aggregate,
  scoreCase,
  wilson,
  type Prediction,
} from '../evals/extraction-score'
const sample = extractionCases.find((c) => c.id === 'multi-independent')!
const predictions: Prediction[] = [
  {
    title: '修复登录白屏',
    stage: 'requested',
    evidence: [{ messageId: 'm1', quote: sample.messages[0]!.text }],
  },
  {
    title: '整理季度预算',
    stage: 'requested',
    evidence: [{ messageId: 'm1', quote: sample.messages[0]!.text }],
  },
]
describe('extraction evaluation is evidence-grounded and does not reward count alone', () => {
  it('matches distinct goals once, counting duplicate and missing tasks separately', () => {
    expect(scoreCase(sample, predictions)).toMatchObject({
      tp: 2,
      fp: 0,
      fn: 0,
      exact: true,
    })
    expect(scoreCase(sample, [predictions[0]!, predictions[0]!])).toMatchObject(
      { tp: 1, fp: 1, fn: 1, duplicates: 1, exact: false },
    )
    expect(
      scoreCase(sample, [
        { ...predictions[0]!, title: '修复登录白屏与整理季度预算' },
      ]),
    ).toMatchObject({ tp: 1, fp: 0, fn: 1 })
  })
  it('finds a maximum matching instead of a greedy match', () => {
    expect(
      scoreCase(sample, [
        { ...predictions[0]!, title: '修复登录白屏与整理季度预算' },
        predictions[0]!,
      ]),
    ).toMatchObject({ tp: 2, fn: 0 })
  })
  it('rejects wrong goals, fabricated quotes and wrong request IDs', () => {
    for (const change of [
      { title: '修复支付跳转' },
      { evidence: [{ messageId: 'm1', quote: '不存在的引用' }] },
      { evidence: [{ messageId: 'missing', quote: sample.messages[0]!.text }] },
    ])
      expect(
        scoreCase(sample, [{ ...predictions[0]!, ...change }, predictions[1]!]),
      ).toMatchObject({ tp: 1, fp: 1, fn: 1, duplicates: 0 })
  })
  it('keeps stage and evidence completeness distinct from finding the goal', () => {
    const scope = {
      ...sample,
      expected: [
        {
          ...sample.expected[0]!,
          stage: 'accepted' as const,
          evidenceIds: ['m1', 'm2'],
        },
      ],
    }
    expect(scoreCase(scope, [predictions[0]!])).toMatchObject({
      tp: 1,
      matchedStageCorrect: 0,
      matchedEvidenceComplete: 0,
      exact: false,
    })
  })
  it('does not reward failed requests on negative cases or invent precision with no predictions', () => {
    const empty = { ...sample, expected: [] }
    const good = scoreCase(empty, [])
    const failed = scoreCase(empty, [], 'MODEL_TIMEOUT')
    expect(
      aggregate([
        { score: good, error: null },
        { score: failed, error: 'MODEL_TIMEOUT' },
      ]),
    ).toMatchObject({
      cases: 2,
      exactCaseRate: 0.5,
      negativeSpecificity: 0.5,
      precision: null,
      recall: null,
      errors: 1,
    })
    expect(wilson(0, 0)).toBeNull()
    expect(wilson(60, 60)![0]).toBeLessThan(0.95)
  })
  it('has independently traceable labels across four formats and negative controls', () => {
    expect(extractionCases).toHaveLength(60)
    expect(new Set(extractionCases.map((c) => c.id)).size).toBe(60)
    for (const sample of extractionCases)
      for (const task of sample.expected) {
        expect(
          task.anchors.every(
            (group) => group.length > 0 && group.every((term) => term.trim()),
          ),
        ).toBe(true)
        for (const id of task.evidenceIds)
          expect(sample.messages.some((m) => m.id === id)).toBe(true)
        for (const id of task.requestIds)
          expect(
            sample.messages.some((m) => m.id === id && m.role === 'user'),
          ).toBe(true)
      }
  })
})

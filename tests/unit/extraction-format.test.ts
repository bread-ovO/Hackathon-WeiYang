import { test, expect } from 'vitest'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdoutCases } from '../fixtures/extraction/holdout'
import { extractionCases } from '../fixtures/extraction/corpus'
import { formatJsonl, normalizer } from '../evals/extraction-format'
import { readLocalJsonl } from '../../packages/plugin-host/src/local-jsonl'

test('every evaluation JSONL fixture round-trips through its production mapper with exact role, text and evidence IDs', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-eval-formats-')),
  )
  try {
    for (const sample of [...extractionCases, ...holdoutCases]) {
      const encoded = formatJsonl(sample.messages, sample.format)
      const path = join(root, `${sample.id}.jsonl`)
      await writeFile(path, encoded.content)
      const batch = await readLocalJsonl({
        path,
        sourceInstanceId: 'synthetic',
        ...normalizer(sample.format),
      })
      const expected = sample.messages.filter(
        (m) =>
          sample.format === 'generic' ||
          m.role === 'user' ||
          m.role === 'assistant',
      )
      expect(batch.done, sample.id).toBe(true)
      expect(
        batch.events.map((event) => ({
          id: encoded.externalToLabel[event.externalId],
          role: event.role,
          text: event.text,
        })),
        sample.id,
      ).toEqual(expected)
      expect(
        (
          await readLocalJsonl({
            path,
            sourceInstanceId: 'synthetic',
            cursor: batch.cursor,
            ...normalizer(sample.format),
          })
        ).events,
        sample.id,
      ).toEqual([])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

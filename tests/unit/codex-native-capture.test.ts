import { it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { readLocalJsonl } from '../../packages/plugin-host/src/local-jsonl'
import {
  codexSessionMapper,
  SESSION_NORMALIZER_IDS,
} from '../../packages/plugin-host/src/session-mappers'
it('reads actual client stdout with capture timestamps and retains user/assistant/tool roles', async () => {
  const batch = await readLocalJsonl({
    path: process.cwd() + '/tests/fixtures/codex-native/session.jsonl',
    sourceInstanceId: 'fixture',
    normalizeRecord: codexSessionMapper,
    normalizerId: SESSION_NORMALIZER_IDS.codex,
  })
  expect(batch.events.map((e) => e.role)).toEqual([
    'user',
    'assistant',
    'tool',
    'assistant',
  ])
  expect(
    batch.events.every((e) => Number.isFinite(Date.parse(e.occurredAt))),
  ).toBe(true)
  expect(batch.events[0]!.text).toContain('BUGU 测试验收报告')
  const capture = JSON.parse(await readFile('tests/fixtures/codex-native/capture.json','utf8'))
  expect(Date.parse(batch.events[0]!.occurredAt)).toBe(Date.parse(capture.records[0].at))
  expect(batch.events[0]!.occurredAt).toContain('+08:00')
  expect(batch.events[2]!.text).toContain('bugu-codex-synthetic-')
  const rows = (
    await readFile('tests/fixtures/codex-native/session.jsonl', 'utf8')
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(() =>
    codexSessionMapper({ ...rows[0], formatVersion: 2 }, { byteOffset: 0 }),
  ).toThrow('UNSUPPORTED_SESSION_FORMAT')
  expect(() =>
    codexSessionMapper({ ...rows[0], timestamp: 'unknown' }, { byteOffset: 0 }),
  ).toThrow('UNSUPPORTED_SESSION_FORMAT')
  expect(() =>
    codexSessionMapper(
      { ...rows[0], payload: { kind: 'event', event: { type: 'new.future' } } },
      { byteOffset: 0 },
    ),
  ).toThrow('UNSUPPORTED_SESSION_FORMAT')
})

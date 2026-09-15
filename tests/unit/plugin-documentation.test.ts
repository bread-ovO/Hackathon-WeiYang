import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  pluginManifestSchema,
  parseSourceManifest,
} from '../../packages/plugin-host/src/manifest'
import { readLocalJsonl } from '../../packages/plugin-host/src/local-jsonl'
import { prepareEventProcessing } from '../../packages/application/src/event-processing'

it('published schema and installable guide example match runtime, preserve source text for the model and reject scope escape', async () => {
  const schema = JSON.parse(
    await readFile('docs/plugins/source-manifest.schema.json', 'utf8'),
  )
  expect(schema).toEqual(pluginManifestSchema)
  const manifest = parseSourceManifest(
    JSON.parse(
      await readFile('examples/sources/release-notes/plugin.json', 'utf8'),
    ),
  )
  const batch = await readLocalJsonl({
    path: resolve('examples/sources/release-notes/events.jsonl'),
    sourceInstanceId: 'guide-source',
    manifest,
  })
  expect(batch.done).toBe(true)
  expect(batch.events).toHaveLength(2)
  const first = batch.events[0]!
  expect(first).toMatchObject({
    externalId: 'release-1',
    revision: '1',
    role: 'user',
    text: '我会提交发布检查报告。',
  })
  for (const [i, event] of batch.events.entries())
    expect(
      prepareEventProcessing({ event, eventId: i + 1, projectId: 'guide' })
        .candidates,
    ).toEqual([])
  expect(() =>
    parseSourceManifest({
      ...manifest,
      transport: { ...manifest.transport, file: '../secret.jsonl' },
    }),
  ).toThrow()
  expect(() =>
    parseSourceManifest({ ...manifest, command: 'run-code' }),
  ).toThrow()
})

import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect } from 'vitest'
import { readLocalJsonl } from '../../packages/plugin-host/src/local-jsonl'
import { createHttpJsonReader } from '../../packages/plugin-host/src/http-json'
import manifest from '../../examples/sources/github-release-assets.json'

it('local JSONL and structurally different HTTP records produce the same validated source event', async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'bugu-source-parity-')),
  )
  try {
    const path = join(root, 'events.jsonl')
    await writeFile(
      path,
      JSON.stringify({
        id: 'one',
        revision: 'v1',
        created_at: '2026-09-13T00:00:00Z',
        role: 'tool',
        content: '虚构构建产物，不表示事项完成',
      }) + '\n',
    )
    const local = await readLocalJsonl({
      path,
      sourceInstanceId: 'parity-source',
    })
    const remote = createHttpJsonReader({
      manifest,
      authorization: {
        sourceInstanceId: 'parity-source',
        domain: 'api.github.com',
      },
      transport: async () =>
        Buffer.from(
          JSON.stringify({
            assets: [
              {
                node_id: 'one',
                updated_at: 'v1',
                created_at: '2026-09-13T00:00:00Z',
                name: '虚构构建产物，不表示事项完成',
              },
            ],
          }),
        ),
    })
    const batch = await remote.read()
    expect(batch.events).toEqual(local.events)
    expect(batch.done).toBe(true)
    expect(Object.keys(batch.events[0]!).sort()).toEqual(
      [
        'schemaVersion',
        'sourceInstanceId',
        'externalId',
        'revision',
        'occurredAt',
        'role',
        'text',
      ].sort(),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

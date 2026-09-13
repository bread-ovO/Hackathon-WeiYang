import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'

// Bundle trusted repository code only. A plugin is JSON data, never an entrypoint.
const args = process.argv.slice(2)
const schemaOnly = args.length === 1 && args[0] === '--schema'
if (!schemaOnly && (args.length < 1 || args.length > 2)) {
  console.error(
    'Usage: node scripts/check-source-plugin.mjs <manifest.json> [sample-directory] | --schema',
  )
  process.exitCode = 1
} else {
  const directory = await mkdtemp(join(tmpdir(), 'bugu-plugin-check-'))
  try {
    const bundle = join(directory, 'reader.cjs')
    await build({
      entryPoints: [resolve('packages/plugin-host/src/index.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    })
    const api = createRequire(import.meta.url)(bundle)
    if (schemaOnly) {
      process.stdout.write(
        JSON.stringify(api.pluginManifestSchema, null, 2) + '\n',
      )
    } else {
      const { manifest } = await api.readPluginManifestFile(resolve(args[0]))
      if (args[1]) {
        if (manifest.kind !== 'local-jsonl')
          throw new Error('SAMPLE_DIRECTORY_REQUIRES_LOCAL_JSONL')
        const result = await api.readLocalJsonl({
          path: resolve(args[1], manifest.transport.file),
          sourceInstanceId: 'plugin-documentation-check',
          manifest,
        })
        console.log(
          JSON.stringify({
            ok: true,
            kind: manifest.kind,
            events: result.events.length,
            done: result.done,
          }),
        )
      } else {
        console.log(
          JSON.stringify({
            ok: true,
            kind: manifest.kind,
            scope: 'manifest-only',
          }),
        )
      }
    }
  } catch (error) {
    // Never print source contents, file paths or arbitrary exception text.
    const known = new Set([
      'PLUGIN_FILE_INVALID',
      'PLUGIN_FILE_LIMIT_EXCEEDED',
      'PLUGIN_MANIFEST_INVALID',
      'PLUGIN_FILE_CHANGED',
      'INVALID_JSONL',
      'INVALID_SOURCE_EVENT',
      'INVALID_UTF8',
      'UNSAFE_PATH',
      'FILE_UNAVAILABLE',
      'FILE_CHANGED',
      'FILE_TOO_LARGE',
      'LINE_TOO_LARGE',
      'INVALID_CURSOR',
      'INVALID_MANIFEST',
    ])
    console.error(
      JSON.stringify({
        ok: false,
        code: known.has(error?.code) ? error.code : 'PLUGIN_CHECK_FAILED',
      }),
    )
    process.exitCode = 1
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

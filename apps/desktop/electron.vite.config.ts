import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
const alias = {
  '@memo/contracts/pet-voice-pcm': resolve(
    __dirname,
    '../../packages/contracts/src/pet-voice-pcm.ts',
  ),
  '@memo/contracts/pet-actions': resolve(
    __dirname,
    '../../packages/contracts/src/pet-actions.ts',
  ),
  ...Object.fromEntries(
    [
      'contracts',
      'domain',
      'application',
      'storage',
      'connectors',
      'plugin-host',
      'model',
      'evals',
    ].map((name) => [
      `@memo/${name}`,
      resolve(__dirname, `../../packages/${name}/src/index.ts`),
    ]),
  ),
}
// Share the release gate with the host so demo data generation is also removed.
const releaseDefines = {
  'import.meta.env.VITE_MEMO_NO_DEMO': JSON.stringify(process.env.VITE_MEMO_NO_DEMO ?? '0'),
}
export default defineConfig({
  main: {
    define: releaseDefines,
    plugins: [
      {
        name: 'clear-stale-bundled-assets',
        buildStart() {
          rmSync(resolve(__dirname, 'out/bundled-pet'), {
            recursive: true,
            force: true,
          })
        },
      },
    ],
    resolve: { alias },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          'pet-worker': resolve(__dirname, 'src/main/pet/worker.ts'),
          index: resolve(__dirname, 'src/main/index.ts'),
          core: resolve(__dirname, 'src/core/index.ts'),
        },
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          pet: resolve(__dirname, 'src/preload/pet.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    define: releaseDefines,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pet: resolve(__dirname, 'src/renderer/pet.html'),
        },
      },
    },
    resolve: { alias },
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    plugins: [
      react(),
      {
        name: 'environment-csp',
        transformIndexHtml: {
          order: 'pre',
          handler(html, context) {
            // React Refresh injects an inline preamble in development only.
            return context.server
              ? html
                  .replace(
                    "script-src 'self';",
                    "script-src 'self' 'unsafe-inline';",
                  )
                  .replace(
                    "script-src 'self' memo-pet://app;",
                    "script-src 'self' memo-pet://app 'unsafe-inline';",
                  )
                  .replace(
                    "connect-src 'self' memo-pet://app;",
                    "connect-src 'self' memo-pet://app ws://127.0.0.1:5173 ws://localhost:5173;",
                  )
              : html.replace(
                  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*;",
                  "connect-src 'self';",
                )
          },
        },
      },
    ],
  },
})

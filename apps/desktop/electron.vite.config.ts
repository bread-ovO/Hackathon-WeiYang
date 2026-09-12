import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
const alias = Object.fromEntries(
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
)
export default defineConfig({
  main: {
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
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } },
    },
  },
  renderer: {
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
              ? html.replace(
                  "script-src 'self';",
                  "script-src 'self' 'unsafe-inline';",
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

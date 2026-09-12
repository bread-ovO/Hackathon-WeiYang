import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
const alias = Object.fromEntries(['contracts','domain','application','storage','connectors','plugin-host','model','evals'].map(name => [`@memo/${name}`, resolve(__dirname, `../../packages/${name}/src/index.ts`)]))
export default defineConfig({
 main: { resolve: { alias }, build: { externalizeDeps: false, rollupOptions: { input: { index: resolve(__dirname,'src/main/index.ts'), core: resolve(__dirname,'src/core/index.ts'), 'pet-worker': resolve(__dirname,'src/main/pet/worker.ts') }, external: ['better-sqlite3'] } } },
 preload: { build: { rollupOptions: { input: { index: resolve(__dirname,'src/preload/index.ts'), pet: resolve(__dirname,'src/preload/pet.ts'), bubble: resolve(__dirname,'src/preload/bubble.ts') }, output: { format:'cjs', entryFileNames:'[name].js' } } } },
 renderer: {
  resolve: { alias },
  build: { rollupOptions: { input: { index: resolve(__dirname,'src/renderer/index.html'), pet: resolve(__dirname,'src/renderer/pet.html'), bubble: resolve(__dirname,'src/renderer/bubble.html') } } },
  server: {host:'127.0.0.1',port:5173,strictPort:true},
  plugins: [react(), {name:'environment-csp',transformIndexHtml:{order:'pre',handler(html,context){
    // React Refresh injects an inline preamble in development only.
    return context.server ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';")
      : html.replace("connect-src 'self' ws://localhost:* ws://127.0.0.1:*;", "connect-src 'self';")
  }}}]
 }
})

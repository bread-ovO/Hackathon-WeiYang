import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'] },
  resolve: {
    alias: {
      '@memo/contracts/pet-voice-pcm': resolve('packages/contracts/src/pet-voice-pcm.ts'),
      '@memo/contracts/foundation': resolve('packages/contracts/src/foundation.ts'),
      ...Object.fromEntries(
        ['domain', 'contracts', 'application', 'plugin-host', 'connectors', 'model'].map(name => [
          `@memo/${name}`, resolve(`packages/${name}/src/index.ts`),
        ]),
      ),
    },
  },
})

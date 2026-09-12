import {defineConfig} from 'vitest/config'
import {resolve} from 'node:path'
export default defineConfig({test:{include:['tests/unit/**/*.test.ts']},resolve:{alias:Object.fromEntries(['domain','contracts','application','plugin-host'].map(n=>[`@memo/${n}`,resolve(`packages/${n}/src/index.ts`)]))}})

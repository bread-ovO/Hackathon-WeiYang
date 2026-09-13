import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'tests/desktop',outputDir:'test-results/playwright',workers:1,timeout:30000,use:{trace:'retain-on-failure'},reporter:'list'})

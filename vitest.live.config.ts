import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Live tests call the real APIs with keys from the environment. They cost a
// few cents and are never part of the normal test run.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    include: ['tests/live/**/*.live.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    reporters: ['verbose'],
  },
})

import { defineConfig } from 'vitest/config'
// Node-environment contract tests (theme token contract) that read the
// filesystem. Kept separate from vitest.config.ts (which runs the
// browser-facing unit suite) so it does not need DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
  },
})

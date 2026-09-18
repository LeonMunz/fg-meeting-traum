import { defineConfig } from '@playwright/test'

/**
 * Fast, browser-free runner for the pure failure-diagnostics logic and
 * the no-browser fixture lifecycle tests. It intentionally defines no
 * webServer, project, trace, or screenshot policy, so it never launches
 * a browser or duplicates the built-in E2E artifact setup.
 *
 * Run: npx playwright test -c playwright.diagnostics.config.ts
 */
export default defineConfig({
  testDir: './e2e/diagnostics/unit',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
})

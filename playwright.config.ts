import {
  defineConfig,
  devices,
} from '@playwright/test'

export default defineConfig({
  testDir: './e2e',

  // Browser-free diagnostics unit tests run under
  // playwright.diagnostics.config.ts and must not be picked up here.
  testIgnore: ['**/diagnostics/unit/**'],

  timeout: 45_000,

  expect: {
    timeout: 7_500,
  },

  fullyParallel: false,
  workers: 1,

  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],

  webServer: [
    {
      command:
        'cd apps/api && ' +
        'DJANGO_SETTINGS_MODULE=config.settings_e2e ' +
        'uv run python manage.py reset_e2e && ' +
        'DJANGO_SETTINGS_MODULE=config.settings_e2e ' +
        'uv run python manage.py runserver ' +
        '127.0.0.1:8010 --noreload',

      url: 'http://127.0.0.1:8010/api/health/',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev:e2e --workspace=web',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})

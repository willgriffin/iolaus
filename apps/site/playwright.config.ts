import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    browserName: 'chromium',
    serviceWorkers: 'block',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'android-portrait',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
    {
      name: 'android-landscape',
      use: { ...devices['Pixel 7'], viewport: { width: 667, height: 375 } },
    },
    {
      name: 'android-narrow',
      use: { ...devices['Pixel 7'], viewport: { width: 320, height: 568 } },
    },
    {
      name: 'desktop-control',
      use: { viewport: { width: 1280, height: 800 }, hasTouch: true },
    },
  ],
});

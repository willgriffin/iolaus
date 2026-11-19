import { defineConfig } from '@playwright/test';

// Connect only: never invokes the source-build/global seed used by other E2E.
export default defineConfig({
  testDir: '.',
  testMatch: 'desktop-mvp.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: process.env.IOLAUS_DESKTOP_EVIDENCE_DIR,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    actionTimeout: 15_000,
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
    // Bootstrap URL and owner cookie are credentials. Capture only deliberate
    // post-bootstrap screenshots, never traces, video or storage attachments.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});

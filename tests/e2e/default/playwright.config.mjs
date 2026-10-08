import path from 'node:path';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '**/*.spec.mjs', workers: 1, fullyParallel: false,
  retries: 0, timeout: 900_000, expect: { timeout: 30_000 },
  reporter: [['dot']], outputDir: path.join(process.env.ZENITH_JOURNEY_SCRATCH ?? '/tmp/zenith-journey-unused', 'playwright'),
  use: { browserName: 'chromium', headless: true, trace: 'off', screenshot: 'off', video: 'off',
    actionTimeout: 30_000, navigationTimeout: 60_000, ignoreHTTPSErrors: false },
});

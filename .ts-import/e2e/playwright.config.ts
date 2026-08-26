/**
 * E2E (yourphr#610): Playwright drives the BUILT Angular app against a booted spike with synthetic
 * data — the same shape as the product repo's `make test-e2e` and the parity audit. One backend,
 * one browser, serial: the journeys share the seeded household.
 */
import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const port = Number(process.env['SPIKE_E2E_PORT'] ?? 18111);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx e2e/server.ts',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

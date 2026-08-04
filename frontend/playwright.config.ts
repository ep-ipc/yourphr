import { defineConfig, devices } from '@playwright/test';
import { BASE_URL } from './e2e/constants';

// The throwaway E2E-account password is generated once at runtime in global-setup and
// written to a gitignored file (no committed credential, #132); the login helper reads it
// back. See e2e/constants.ts.

// E2E config: drives a real browser against the PRODUCTION-SERVED path — the Go backend
// serving the built dist under /web (config.e2e.yaml), not `ng serve` (which wouldn't
// apply the backend CSP). `make test-e2e` builds the frontend first.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,        // single backend + shared seeded account
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    // chromium runs the whole suite. firefox runs only the browser-behavior specs (CSP guard,
    // login, custom-element registration) — the multi-browser matrix's actual purpose. The
    // data/seeded-content specs (data.spec, binary-document, medical-history, lforms-modal) are either
    // browser-independent (API responses, PDF/Binary bytes, download wiring) or depend on the seeded
    // Synthea data, so running them on firefox adds no coverage and just doubles flake exposure
    // (binary-document's download/embed path is genuinely firefox-incompatible). smart-connect IS a
    // browser-behavior spec (window.open popup), so it stays in the firefox matrix.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: [
        '**/data.spec.ts',
        '**/binary-document.spec.ts',
        '**/medical-history.spec.ts',
        '**/allergies-immunizations.spec.ts',
        '**/lforms-modal.spec.ts',
        '**/sandbox-connect.spec.ts',
      ],
    },
  ],
  // Boot the Go backend with a fresh test DB, serving the built dist. cwd is the repo
  // root (one level up from frontend/). `go run` recompiles, hence the generous timeout.
  webServer: {
    // mkdir -p db: the db/ dir is gitignored, so it's absent on a fresh CI checkout and
    // sqlite can't create the test DB without it (no-op locally).
    command:
      'mkdir -p db && rm -f db/fasten-e2e.db db/fasten-e2e.db-shm db/fasten-e2e.db-wal && ' +
      // Inline env rather than a .env file: cwd is the repo root, so a developer's own .env
      // would otherwise leak into the test run. Real environment variables outrank .env, so
      // this stays hermetic either way. Replaces config.e2e.yaml (yourphr#474).
      'YOURPHR_WEB_LISTEN_PORT=9191 ' +           // never collides with the dev backend on 9090
      'YOURPHR_WEB_SRC_FRONTEND_PATH=./dist ' +   // repo-root ./dist = the Angular build output
      'YOURPHR_STORAGE_DATA_DIR=./db ' +
      'YOURPHR_DATABASE_LOCATION=./db/fasten-e2e.db ' +
      'YOURPHR_DATABASE_ENCRYPTION_ENABLED=false ' + // default is ON; E2E needs no key prompt
      'YOURPHR_CDA_CONVERTER_ENABLED=false ' +    // no converter sidecar in CI
      'YOURPHR_LOG_LEVEL=INFO ' +                 // per-resource import logs, for #148
      'go run backend/cmd/fasten/fasten.go start',
    cwd: '..',
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

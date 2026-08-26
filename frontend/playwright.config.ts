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
      // Port preflight (#481). Two different things can go wrong when :9191 is already taken, and
      // both used to be silent or cryptic:
      //   1. the squatter serves /web, so Playwright's url probe succeeds and it REUSES it — the
      //      fresh-database step below never runs. Caught in e2e/global-setup.ts.
      //   2. the squatter does not serve /web, so the probe fails, Playwright starts this command,
      //      and the bind fails with "Process from config.webServer was not able to start.
      //      Exit code: 1" — which names neither the port nor the cause.
      // This catches (2) before `go run` and says what to do. curl rather than lsof: lsof is not
      // guaranteed on a CI runner, and a YourPHR backend on the port is the case that matters.
      'if curl -sf -o /dev/null --max-time 2 http://localhost:9191/api/health; then ' +
      'echo "" >&2; ' +
      'echo "[e2e] REFUSING TO START — something is already serving on :9191." >&2; ' +
      'echo "[e2e] This harness needs the port to itself: it deletes and re-seeds db/fasten-e2e.db." >&2; ' +
      'echo "[e2e] Free it and re-run:  lsof -ti:9191 | xargs kill" >&2; ' +
      'echo "" >&2; exit 1; fi && ' +
      'mkdir -p db && rm -f db/fasten-e2e.db db/fasten-e2e.db-shm db/fasten-e2e.db-wal && ' +
      // Inline env rather than a .env file: cwd is the repo root, so a developer's own .env
      // would otherwise leak into the test run. Real environment variables outrank .env, so
      // this stays hermetic either way. Replaces config.e2e.yaml (yourphr#474).
      'YOURPHR_WEB_LISTEN_PORT=9191 ' +           // never collides with the dev backend on 9090
      'YOURPHR_WEB_SRC_FRONTEND_PATH=./dist/web ' + // the Angular build output (yourphr#652: one
      //                                             dist/, dist/web for the app, dist/server for
      //                                             the compiled backend — the Angular build clears
      //                                             its own output directory, so they cannot share)
      'YOURPHR_STORAGE_DATA_DIR=./db ' +
      'YOURPHR_DATABASE_LOCATION=./db/fasten-e2e.db ' +
      'YOURPHR_DATABASE_ENCRYPTION_ENABLED=false ' + // default is ON; E2E needs no key prompt
      'YOURPHR_CDA_CONVERTER_ENABLED=false ' +    // no converter sidecar in CI
      // The suite drives ~16 real logins from one IP, against a production default of 10 per
      // minute — so it was collecting 429s mid-run, which the sign-in page rendered as "username
      // or password is incorrect". That reads as a login regression rather than a throttle, and
      // it is why the login spec was intermittently "flaky" only in the full suite (#481).
      'YOURPHR_WEB_RATE_LIMIT_AUTH_PER_MINUTE=1000 ' +
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

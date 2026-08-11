import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { request, FullConfig } from '@playwright/test';
import { API_BASE, E2E_USER, PASS_FILE, SEED_BUNDLE } from './constants';

// Runs once after the webServer (Go backend) is up, before any tests:
//  1. Generate a throwaway account password at runtime (no committed credential, #132) and
//     write it to a gitignored file the login helper reads (same value in every worker).
//  2. Create (or sign in to) the E2E account via the public auth API; capture the bearer token.
//  3. Seed a synthetic Synthea bundle via POST /api/secure/source/manual (Bearer-authed) so
//     data-dependent flows have content (#131 Phase 3). RequireAuth takes the Authorization
//     header first, which sidesteps sending the Secure session cookie over http from a non-browser.
// assertHarnessServer refuses to run against a backend this harness did not start (#481).
//
// playwright.config.ts sets `reuseExistingServer: !process.env.CI`, so locally Playwright attaches
// to ANYTHING already listening on the port — including a backend holding a completely different
// database. The webServer command's `rm -f db/fasten-e2e.db` is what guarantees a clean seeded
// account, and on a reused server that command never runs, so the guarantee silently does not hold.
//
// The resulting failure points at the application: the specs that need the seeded account fail on
// login while the rest pass, and nothing in the output mentions reuse. That cost a "did the
// dependency bump break authentication?" investigation before the port was suspected.
//
// The check is `first_run_wizard` from /api/health: the harness always starts from a deleted
// database, so a genuine harness server has NO users and reports true. A dev backend someone left
// running has an account and reports false. That is a cheap, unambiguous signal — it needs no new
// endpoint and cannot be faked by a coincidence of ports.
async function assertHarnessServer(): Promise<void> {
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(`${API_BASE}/health`, { timeout: 10_000 });
    if (!res.ok()) return; // not a YourPHR backend, or not up yet — webServer will deal with it
    const data = (await res.json())?.data ?? {};
    if (data.first_run_wizard === false) {
      throw new Error(
        `\n\n[e2e] REFUSING TO RUN — the backend on ${API_BASE} already has user accounts, so it is ` +
        `not the throwaway one this harness starts.\n` +
        `Playwright reused an existing server (reuseExistingServer is on outside CI), so the ` +
        `fresh-database step never ran and the seeded e2e account does not exist there.\n` +
        `Tests would fail on login and look like an application bug.\n\n` +
        `Free the port and re-run:  lsof -ti:9191 | xargs kill\n`
      );
    }
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup(_config: FullConfig) {
  await assertHarnessServer();

  const pass = process.env.E2E_PASS || randomBytes(18).toString('hex');
  writeFileSync(PASS_FILE, pass, { mode: 0o600 });

  const ctx = await request.newContext();
  try {
    let token = '';
    const signup = await ctx.post(`${API_BASE}/auth/signup`, { data: { username: E2E_USER, password: pass } });
    if (signup.ok()) {
      token = (await signup.json())?.data ?? '';
      console.log(`[e2e] seeded account "${E2E_USER}"`);
    } else {
      // account likely already exists (reused dev server) — sign in for a token
      const signin = await ctx.post(`${API_BASE}/auth/signin`, { data: { username: E2E_USER, password: pass } });
      if (signin.ok()) token = (await signin.json())?.data ?? '';
      console.log(`[e2e] signup ${signup.status()}; signin ${signin.status()} — continuing`);
    }

    if (token) {
      const res = await ctx.post(`${API_BASE}/secure/source/manual`, {
        headers: { Authorization: `Bearer ${token}` },
        multipart: { file: { name: 'synthea.json', mimeType: 'application/json', buffer: readFileSync(SEED_BUNDLE) } },
        timeout: 120_000,
      });
      // #148 diagnostic: log the raw seed response body. On 500 it carries the import's error
      // message (the actual root cause — the import, not the IPS render, is what fails in CI);
      // on 200 it's the summary (shows whether a Patient was stored + the real JSON shape).
      console.log(`[e2e] seed bundle import -> HTTP ${res.status()}; body: ${(await res.text()).slice(0, 800)}`);

      // Readiness gate: the import processes resources (related-resources / search params)
      // asynchronously after returning 200, so a too-early IPS summary query can 500. Wait
      // until the (cheap JSON) IPS summary succeeds before tests run, so data-dependent specs
      // see a settled state. (Backend should also not 500 on in-progress data — see the issue.)
      for (let i = 0; i < 20; i++) {
        const r = await ctx.get(`${API_BASE}/secure/summary/ips`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok()) { console.log(`[e2e] IPS data ready after ~${i * 3}s`); break; }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } else {
      console.log('[e2e] no token — skipped data seed; data-dependent specs will see an empty account');
    }
  } catch (e) {
    console.log(`[e2e] setup issue (${e}) — continuing`);
  } finally {
    await ctx.dispose();
  }
}

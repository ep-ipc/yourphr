import { expect, test } from '@playwright/test';
import { BASE, login, trackPageErrors } from './helpers.js';
import { E2E_PASS, E2E_USER } from './constants.js';

// yourphr#690 (display, carried from #678): the medical-history, allergies and immunizations pages
// show seeded records in words a person reads. Visiting a page is not the assertion; what it says is.
// Seeds: e2e/server.ts (synthetic only).

test('the allergies page names the substance and the reaction, not codes', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  await page.goto(`${BASE}/allergies`);
  await expect(page.getByText('Peanut').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Hives').first()).toBeVisible();
  // Legible means no bare code in place of a name.
  await expect(page.getByText('256349002')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the immunizations page names the vaccine and when it was given', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  await page.goto(`${BASE}/immunizations`);
  await expect(page.getByText(/Influenza/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/2025/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

// Medical history is built from visits (Encounters), grouped by the person's choice. The seeded visit
// names its practitioner, so grouping by Provider must file it under them.
test('the medical-history page shows the visit, by date and by provider', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  await page.goto(`${BASE}/medical-history`);
  await expect(page.getByRole('heading', { name: 'Synthetic annual check-up' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Mar 14, 2026' })).toBeVisible();
  // The last sync the source reports (the E2E server syncs on a fixed clock), never an invented date.
  await expect(page.getByTestId('last-updated')).not.toHaveText('');

  await page.getByRole('button', { name: 'Provider' }).click();
  await expect(page.getByRole('button', { name: /Dr Linus Seeded/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Synthetic annual check-up' })).toBeVisible();
  expect(errors).toEqual([]);
});

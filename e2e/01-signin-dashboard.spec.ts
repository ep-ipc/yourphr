import { expect, test } from '@playwright/test';
import { BASE, login, trackPageErrors } from './helpers.js';
import { E2E_PASS, E2E_USER } from './constants.js';

test('a member signs in through the form and lands on a dashboard that counts their synced records', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  // The fake provider synced 3 Conditions and 1 MedicationStatement; the tiles say so.
  await expect(page.locator('.tile', { hasText: 'Medications' })).toContainText('1', { timeout: 20_000 });
  await expect(page.locator('.tile', { hasText: 'Medical Concerns' })).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
  // A wrong password is refused with the generic message — no account enumeration on the form.
  await page.goto(`${BASE}/auth/signin`);
  await page.getByPlaceholder('Enter your username').fill(E2E_USER);
  await page.getByPlaceholder('Enter your password').fill('not-the-password-at-all');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/auth\/signin/);
  await expect(page.getByRole('alert').filter({ hasText: /incorrect|invalid/i }).first()).toBeVisible({ timeout: 10_000 }); // the page's own wording, never the account's existence
});

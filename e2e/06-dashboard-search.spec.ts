import { expect, test } from '@playwright/test';
import { login, trackPageErrors } from './helpers.js';
import { E2E_PASS, E2E_USER } from './constants.js';

test('a member types a word into the dashboard search box and their own record comes back (yourphr#599)', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  const box = page.getByLabel('Search your record');
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.fill('lisinopril');
  // The fake provider synced one MedicationStatement named "Lisinopril 10 MG"; the box lists it.
  await expect(page.locator('.search-item', { hasText: /Lisinopril/i }).first()).toBeVisible({ timeout: 15_000 });
  await box.fill('nothing-like-this-exists');
  await expect(page.locator('.search-item')).toHaveCount(0, { timeout: 15_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});

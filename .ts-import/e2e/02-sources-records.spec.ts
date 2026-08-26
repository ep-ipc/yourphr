import { expect, test } from '@playwright/test';
import { BASE, login, trackPageErrors } from './helpers.js';
import { E2E_PASS, E2E_USER } from './constants.js';

test('the Sources page lists the connected provider and Explore opens its records', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  await page.goto(`${BASE}/sources`);
  await expect(page.getByText('Fake Regional Health').first()).toBeVisible({ timeout: 20_000 });
  await page.goto(`${BASE}/explore`);
  const tile = page.locator('app-medical-sources-card', { hasText: 'Fake Regional Health' }).locator('.card-body').first();
  await expect(tile).toBeVisible({ timeout: 20_000 });
  await tile.click();
  await expect(page).toHaveURL(/\/explore\/source-\d+/, { timeout: 20_000 });
  // The source page counts what the fake provider sent: 3 Conditions, 1 "Medication taken".
  const conditionRow = page.locator('.list-group-item, li, a, tr').filter({ hasText: /^\s*Condition\s*3\s*$/ }).first();
  await expect(conditionRow).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Medication taken')).toBeVisible();
  await conditionRow.click();
  await expect(page.getByText(/synthetic Condition/i).first()).toBeVisible({ timeout: 20_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});

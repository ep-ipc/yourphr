import { expect, test } from '@playwright/test';
import { BASE, login, trackPageErrors } from './helpers.js';
import { E2E_PASS, E2E_USER } from './constants.js';

// yourphr#690 (display, carried from #678): a record's detail page is checked against what was
// seeded — reaching it proves nothing. The fake provider (scripts/lib/fake-provider.ts) serves three
// Conditions coded "synthetic Condition N", recorded 2024-01-10.
test('a condition opens to a detail page that shows its own name and date', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  await page.goto(`${BASE}/explore`);
  await page.locator('app-medical-sources-card', { hasText: 'Fake Regional Health' }).locator('.card-body').first().click();
  await expect(page).toHaveURL(/\/explore\/source-\d+/, { timeout: 20_000 });
  await page.locator('.list-group-item, li, a, tr').filter({ hasText: /^\s*Condition\s*3\s*$/ }).first().click();

  await page.getByRole('row', { name: /synthetic Condition 2/ }).click();
  await expect(page).toHaveURL(/\/explore\/source-\d+\/resource\//, { timeout: 20_000 });
  await expect(page.getByText('synthetic Condition 2').first()).toBeVisible({ timeout: 20_000 });
  // Its own record, not a neighbour's.
  await expect(page.getByText('synthetic Condition 1')).toHaveCount(0);
  await expect(page.getByText(/Jan\w* 10,? 2024|2024-01-10|01\/10\/2024/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

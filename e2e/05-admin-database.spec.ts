import { expect, test } from '@playwright/test';
import { BASE, adminPassword, login, trackPageErrors } from './helpers.js';

test('the admin takes a backup from the Database page and sees it listed', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, 'admin', adminPassword());
  await page.goto(`${BASE}/admin/database`);
  await page.getByRole('button', { name: /back up to server now/i }).click();
  await expect(page.getByText(/-yourphr-spike-backup\.db/).first()).toBeVisible({ timeout: 30_000 });
  expect(errors, errors.join('\n')).toEqual([]);
});

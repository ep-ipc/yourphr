import { expect, test } from '@playwright/test';
import { BASE, login, trackPageErrors } from './helpers.js';
import { E2E_NOTE_PASS, E2E_NOTE_USER } from './constants.js';

// yourphr#793. A notification reaches the person it is for without them going to look for it — the
// banner is on every signed-in page — and dismissing it hides it for them, for good.
test('a person sees their notification on every page, dismisses it, and it stays gone', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_NOTE_USER, E2E_NOTE_PASS);

  const banner = page.getByTestId('notification-banner');
  await expect(banner).toContainText('No backup in over 26 hours', { timeout: 20_000 });
  await expect(banner.getByRole('alert')).toHaveClass(/alert-danger/);

  await page.goto(`${BASE}/settings`);
  await expect(page.getByTestId('notification-banner')).toContainText('No backup in over 26 hours', { timeout: 20_000 });

  await page.getByTestId('notification-banner').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('notification-banner')).toHaveCount(0);

  // The server's, not the page's: a reload does not bring it back.
  await page.reload();
  await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('notification-banner')).toHaveCount(0);

  expect(errors).toEqual([]);
});

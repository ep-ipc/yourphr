import { expect, test } from '@playwright/test';
import { BASE, login } from './helpers.js';
import { E2E_PW_PASS, E2E_PW_USER } from './constants.js';

test('a member changes their password from Account Profile and the new one signs in', async ({ page }) => {
  await login(page, E2E_PW_USER, E2E_PW_PASS);
  await page.goto(`${BASE}/account-profile`);
  const next = 'carols-newer-long-password';
  await page.locator('#pw-current').fill(E2E_PW_PASS);
  await page.locator('#pw-next').fill(next);
  await page.locator('#pw-confirm').fill(next);
  await page.locator('#pw-next').locator('xpath=ancestor::form').getByRole('button', { name: /change|update|save/i }).first().click();
  await expect(page.getByText('Your password has been changed.')).toBeVisible({ timeout: 15_000 });
  // The change ended every other session; this one rode back on the cookie. Sign in fresh with the new password.
  await page.context().clearCookies();
  await login(page, E2E_PW_USER, next);
});

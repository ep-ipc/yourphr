import { expect, test } from '@playwright/test';
import { BASE, adminPassword, login, trackPageErrors } from './helpers.js';

// Every card on the admin dashboard is a door to an admin page. On the live instance none of them
// opened (2026-09-26): the admin could reach /admin but not the provider catalog, so no provider
// could be added and no patient could connect. This walks each door and fails on the first one
// that does not open, or on any uncaught error along the way.
const DOORS: { name: RegExp; url: RegExp }[] = [
  { name: /manage providers/i, url: /\/admin\/provider-catalog$/ },
  { name: /view server logs/i, url: /\/admin\/logs$/ },
  { name: /open database/i, url: /\/admin\/database$/ },
  { name: /open configuration/i, url: /\/admin\/config$/ },
  { name: /open sandbox testing/i, url: /\/sandbox$/ },
];

for (const door of DOORS) {
  test(`admin dashboard: "${door.name.source}" opens its page`, async ({ page }) => {
    const errors = trackPageErrors(page);
    await login(page, 'admin', adminPassword());
    await page.goto(`${BASE}/admin`);
    await page.getByRole('link', { name: door.name }).click();
    await expect(page).toHaveURL(door.url, { timeout: 15_000 });
    expect(errors).toEqual([]);
  });
}

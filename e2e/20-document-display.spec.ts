import { expect, test, type Page } from '@playwright/test';
import { BASE, login, trackPageErrors } from './helpers.js';
import { E2E_PASS, E2E_USER } from './constants.js';

// yourphr#690 (display, carried from #678): a record whose content is a document opens and RENDERS
// — a DICOM image drawn by the viewer, a PDF embedded — rather than the "could not be retrieved"
// warning. Seeds: the frontend's synthetic fixtures (e2e/server.ts).

/** Where the seeded Binary lives: its source, read the way the app reads it. */
async function detailUrl(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`${BASE}/api/secure/resource/fhir?sourceResourceType=Binary`);
  const rows = ((await res.json()) as { data: { source_id: string; source_resource_id: string }[] }).data;
  const row = rows.find((r) => r.source_resource_id === id);
  expect(row, `seeded Binary ${id} is listed`).toBeTruthy();
  return `${BASE}/explore/${row!.source_id}/resource/Binary/${id}`;
}

test('a DICOM image opens and the viewer draws it', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  await page.goto(await detailUrl(page, 'e2e-exampledicom'));
  const canvas = page.locator('#layerGroup0 canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  // Drawn, not merely sized: some pixels carry the image (dwv paints a blank canvas black).
  // The e2e tsconfig carries no DOM types, so the canvas is described by what is used of it.
  type Canvas = { width: number; height: number; getContext(kind: '2d'): { getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } } | null };
  await expect.poll(async () => canvas.evaluate((el) => {
    const c = el as unknown as Canvas;
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0 || c.height === 0) return 0;
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i]! + px[i + 1]! + px[i + 2]! > 30) lit++;
    return lit;
  }), { timeout: 30_000, message: 'the viewer drew image pixels' }).toBeGreaterThan(100);
  await expect(page.getByText('This document could not be retrieved')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a PDF opens embedded, with a download', async ({ page }) => {
  const errors = trackPageErrors(page);
  await login(page, E2E_USER, E2E_PASS);
  await page.goto(await detailUrl(page, 'e2e-examplepdf'));
  await expect(page.locator('fhir-pdf embed')).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(page.getByText('This document could not be retrieved')).toHaveCount(0);
  expect(errors).toEqual([]);
});

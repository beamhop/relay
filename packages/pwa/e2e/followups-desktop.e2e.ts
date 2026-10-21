// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop: ⌘K reaches Insights and the Launch kit. */
import { expect, test } from '@playwright/test';
import { signedIn } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__reset', { data: { claimed: true, ai: 'absent' } });
  await signedIn(page);
});

for (const [query, url] of [
  ['insights', /\/admin\/insights$/],
  ['launch kit', /\/admin\/launch$/],
] as const) {
  test(`⌘K finds “${query}”`, async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.getByTestId('health-score')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await page.keyboard.type(query);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(url);
  });
}

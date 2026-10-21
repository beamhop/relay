// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone: settings deep links focus the field (launch kit), approvals sit under Activity. */
import { expect, test } from '@playwright/test';
import { signedIn } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__reset', { data: { claimed: true, ai: 'absent' } });
  await signedIn(page);
});

test('a settings deep link scrolls to, focuses and highlights the field', async ({ page }) => {
  await page.goto('/admin/settings/profile?field=info.name');
  const field = page.locator('[data-setting-field="info.name"]');
  await expect(field).toHaveAttribute('data-highlighted', 'true');
  await expect(field.locator('[data-setting-input]')).toBeFocused();
  await expect(field).not.toHaveAttribute('data-highlighted', 'true', { timeout: 5000 });
});

test('a deep link to an Advanced setting opens the Advanced sheet first', async ({ page }) => {
  await page.goto('/admin/settings/profile?field=info.pubkey');
  const field = page.locator('[data-setting-field="info.pubkey"]');
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute('data-highlighted', 'true');
  await expect(field.locator('[data-setting-input]')).toBeFocused();
});

test('approvals highlight the Activity tab', async ({ page }) => {
  await page.request.post('/__reset', { data: { claimed: true, ai: 'absent', enterprise: true } });
  await page.goto('/admin/m/approvals');
  const current = page.getByTestId('tab-bar').locator('a[aria-current="page"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute('href', /\/activity$/);
});

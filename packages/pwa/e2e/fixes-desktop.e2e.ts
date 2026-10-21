import { bytesToHex } from '@noble/hashes/utils.js';
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop parity for the user-testing fixes (1440×900). */
import { expect, test } from '@playwright/test';
import { generateSecretKey } from 'nostr-tools/pure';
import { reset, serverLog, signedIn } from './helpers.ts';

test('private key sign-in works on desktop', async ({ page }) => {
  await reset(page, true);
  await page.goto('/admin/');
  await page.getByTestId('signin-key').click();
  await page.getByTestId('key-input').fill(bytesToHex(generateSecretKey()));
  await page.getByTestId('key-submit').click();
  await expect(page.getByTestId('health-score')).toHaveText('92');
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test('the sidebar logo goes Home', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/settings/goals');
    await page.getByTestId('brand-home').click();
    await expect(page).toHaveURL(/\/admin\/?$/);
  });

  test('palette: grouped with icons, recent first, ids only under the lens', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/');
    await expect(page.getByTestId('health-score')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette.getByTestId('palette-group-people')).toContainText('Create invite');
    await expect(palette.getByText('access.create-invite')).toHaveCount(0);
    await page.keyboard.type('history');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/admin\/settings\/history$/);

    await page.keyboard.press('t'); // technical lens on
    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette.getByTestId('palette-recent')).toContainText('Settings history');
    await expect(palette.getByText('access.create-invite').first()).toBeVisible();
  });

  test('toasts sit beside the content and never block clicks', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/settings/privacy');
    await page.locator('[data-setting-field="relays.0.public.portal"] [role="switch"]').click();
    await page.getByTestId('section-save').click();
    const review = page.getByTestId('config-diff-sheet');
    await review.getByTestId('config-apply').click();
    await expect(review).toBeHidden();
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    const box = await toast.boundingBox();
    expect(box && box.x >= 232).toBeTruthy(); // not over the sidebar
    // Right of the toast, on the same line: the page, not the toast layer.
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="toaster"]') !== null,
      { x: (box?.x ?? 0) + (box?.width ?? 0) + 60, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 },
    );
    expect(hit).toBe(false);
    // The sidebar stays usable while the toast is up.
    await page.getByTestId('sidebar').getByRole('link', { name: 'Home' }).click();
    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(toast).toBeVisible();
    await toast.getByTestId('toast-close').click();
    await expect(toast).toHaveCount(0);
  });

  test('plugins and company sign-in on desktop', async ({ page }) => {
    await reset(page, true, { tripped: true });
    await page.goto('/admin/settings/plugins');
    await expect(page.getByTestId('plugin-safety')).toBeVisible();
    await expect(page.getByTestId('plugin-available')).toHaveCount(2);

    await page.goto('/admin/settings/company');
    await page.getByTestId('company-enable').click();
    await page.getByTestId('action-sheet').getByTestId('action-confirm').click();
    await page.getByTestId('provider-other').click();
    await expect(page.getByTestId('redirect-uri')).toContainText('/sso/oidc/callback');
    await expect(page.getByTestId('scim-token')).toHaveText('scim-token-123');
    expect((await serverLog(page)).modules['enterprise-identity']).toBe(true);
  });
});

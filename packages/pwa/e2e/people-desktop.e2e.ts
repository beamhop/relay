// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop parity for People bulk actions (checkbox + shift-click) and Security tokens (1440×900). */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

test.describe('desktop People & Security', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
    await reset(page, true);
  });

  test('checkbox then shift-click selects a range; bulk block with one undo', async ({ page }) => {
    await page.goto('/admin/people');
    const rows = page.getByTestId('user-row');
    await expect(rows).toHaveCount(3);
    await rows.first().getByTestId('user-check').click();
    await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
    await rows
      .nth(2)
      .getByTestId('user-pick')
      .click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('bulk-count')).toHaveText('3 selected');

    await page.getByTestId('bulk-ban').click();
    const sheet = page.getByTestId('bulk-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('3 accounts will be blocked');
    await sheet.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('users-list').getByText('Blocked', { exact: true })).toHaveCount(
      3,
    );
    expect((await serverLog(page)).bans).toHaveLength(3);
    await page.getByTestId('toast-undo').first().click();
    await expect(page.getByTestId('users-list').getByText('Blocked', { exact: true })).toHaveCount(
      0,
    );
    expect((await serverLog(page)).bans).toHaveLength(0);
  });

  test('revoke a token with the button', async ({ page }) => {
    await page.goto('/admin/settings/security');
    await expect(page.getByTestId('token-row')).toHaveCount(1);
    await page.getByTestId('token-revoke').click();
    await expect(page.getByTestId('token-row')).toHaveCount(0);
    await expect(page.getByTestId('tokens')).toContainText('No API tokens yet.');
  });
});

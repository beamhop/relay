// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop parity (§6.14): Settings → Updates & health. */
import { expect, test } from '@playwright/test';
import { reset, signedIn } from './helpers.ts';

test.describe('updates & health (desktop)', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
    await reset(page, true);
  });

  test('update, doctor and advice on one screen; go back from the toast', async ({ page }) => {
    await page.goto('/admin/settings/system');
    const card = page.getByTestId('update-card');
    await expect(card.getByTestId('current-version')).toHaveText('You have version 0.1.0.');
    await expect(page.getByTestId('doctor').getByTestId('doctor-summary')).toContainText(
      '1 problem(s)',
    );
    await expect(page.getByTestId('advisor').getByTestId('advisor-size')).toContainText('1 vCPU');

    await card.getByTestId('update-now').click();
    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('Back up your data');
    await sheet.getByTestId('action-confirm').click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Updated to 0.2.0' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(card.getByTestId('rollback-row')).toContainText('Version 0.1.0 is kept');

    // The toast offers going back too.
    await page
      .getByTestId('toast')
      .filter({ hasText: 'Updated to 0.2.0' })
      .getByTestId('toast-undo')
      .click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('action-continue')).toBeVisible();
  });
});

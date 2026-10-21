// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone: a written plugin's declared access stays off until the owner allows it (preview → undo). */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

test('plugin writer: Allow this access → preview in plain words → undo', async ({ page }) => {
  await signedIn(page);
  await reset(page, true, { ai: 'on' });
  await page.goto('/admin/settings/plugins');
  await page.getByTestId('plugin-write').click();
  const sheet = page.getByTestId('plugin-writer');
  await sheet.getByTestId('plugin-writer-example').first().click();
  await page.getByTestId('plugin-writer-generate').click();
  await expect(sheet.getByTestId('plugin-writer-installed')).toBeVisible();

  await sheet.getByTestId('plugin-writer-allow').click();
  const flow = page.getByTestId('action-sheet');
  await expect(flow.getByTestId('diff')).toContainText(
    'will be able to: read posts and profiles stored on this relay',
  );
  expect((await serverLog(page)).log.map((l) => l.id)).not.toContain('plugins.grant-permissions');
  await flow.getByTestId('action-confirm').click();
  await expect(sheet.getByTestId('plugin-writer-allowed')).toBeVisible();
  expect((await serverLog(page)).log.map((l) => l.id)).toContain('plugins.grant-permissions');

  await page.getByTestId('toast-undo').first().click();
  await expect(sheet.getByTestId('plugin-writer-allow')).toBeVisible();
});

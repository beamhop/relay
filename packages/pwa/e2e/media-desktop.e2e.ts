// SPDX-License-Identifier: AGPL-3.0-or-later
/** Media tab on desktop (§6.14 parity): tiers card, quarantine buttons, file sheet with notes. */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await reset(page, true);
  await signedIn(page);
});

test('media: tiers, quarantine delete, file notes with the keyboard and mouse', async ({
  page,
}) => {
  await page.goto('/admin/media?tab=usage');
  await expect(page.getByTestId('storage-tiers').getByTestId('tier-hot')).toContainText(
    '8.5 GB of 10 GB',
  );
  await expect(page.getByTestId('cleanup-status')).toBeVisible();

  await page.goto('/admin/media?tab=quarantine');
  const rows = page.getByTestId('q-row');
  await expect(rows).toHaveCount(2);
  await rows.first().getByTestId('q-confirm').click();
  const sheet = page.getByTestId('action-sheet');
  await expect(sheet.getByTestId('diff')).toContainText('This cannot be undone.');
  await sheet.getByTestId('action-confirm').click();
  await expect(rows).toHaveCount(1);

  await page.goto('/admin/media');
  await page.getByTestId('media-tile').nth(1).click();
  const file = page.getByTestId('file-sheet');
  await file.getByTestId('file-note-input').fill('Invoice, keep');
  await file.getByTestId('file-note-input').press('Enter');
  await expect(file.getByTestId('file-note')).toHaveText(/Invoice, keep/);
  await page.keyboard.press('Escape');
  await expect(file).toBeHidden();
  const log = (await serverLog(page)).log.map((l) => l.id);
  expect(log).toEqual(expect.arrayContaining(['media.confirm-quarantine', 'notes.add']));
});

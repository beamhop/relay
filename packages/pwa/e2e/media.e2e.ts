// SPDX-License-Identifier: AGPL-3.0-or-later
/** Media tab on a phone: storage tiers + move now, cleanup line, quarantine review, file details + notes. */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn, touchSwipe } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await reset(page, true);
  await signedIn(page);
});

test('storage tiers: bars, why, move now; cleanup status line', async ({ page }) => {
  await page.goto('/admin/media?tab=usage');
  const card = page.getByTestId('storage-tiers');
  await expect(card.getByTestId('tier-hot').getByTestId('quota-text')).toHaveText(
    '8.5 GB of 10 GB · 1.5 GB left',
  );
  await expect(card.getByTestId('tier-hot')).toHaveAttribute('data-level', 'warn');
  await expect(card.getByTestId('tier-cold')).toContainText('2 GB used');
  await expect(card.getByTestId('tiers-job')).toContainText(
    'Files nobody opened for 30 days move to cheaper storage.',
  );
  await expect(card.getByTestId('why-button')).toBeVisible();
  await expect(page.getByTestId('cleanup-status')).toContainText(
    'Cleanup ran 30m ago and freed 12 MB',
  );

  await card.getByTestId('tiers-move-now').click();
  const sheet = page.getByTestId('action-sheet');
  await expect(sheet.getByTestId('diff')).toContainText('They keep working');
  await sheet.getByTestId('action-confirm').click();
  await expect(page.getByTestId('toast')).toContainText('Moved 4 files');
  await expect(card.getByTestId('tiers-job')).toContainText(
    'Last moved just now: 4 files (200 MB)',
  );
  expect((await serverLog(page)).log.map((l) => l.id)).toContain('media.run-tiering');
});

test('quarantine: abuse match is never shown; release with undo; swipe to delete for good', async ({
  page,
}) => {
  await page.goto('/admin/media?tab=quarantine');
  const rows = page.getByTestId('q-row');
  await expect(rows).toHaveCount(2);
  const abuse = page.locator('[data-testid="q-row"][data-abuse="true"]');
  await expect(abuse.getByTestId('q-reason')).toHaveText('Matched a known-abuse list');
  await expect(abuse.locator('img')).toHaveCount(0);
  await expect(abuse.getByTestId('q-thumb-abuse')).toBeVisible();

  const ruled = page.locator('[data-testid="q-row"][data-abuse="false"]');
  const img = ruled.locator('img');
  await expect(img).toHaveAttribute('data-revealed', 'false');
  await ruled.getByTestId('q-thumb-toggle').click();
  await expect(img).toHaveAttribute('data-revealed', 'true');

  // Release runs at once (it is undoable) → undo puts the file back on hold.
  await ruled.getByTestId('q-release').click();
  const sheet = page.getByTestId('action-sheet');
  await expect(rows).toHaveCount(1);
  await expect(sheet).toHaveCount(0);
  await page.getByTestId('toast-undo').click();
  await expect(rows).toHaveCount(2);

  // An abuse-list match is previewed before it is released.
  await abuse.getByTestId('q-release').click();
  await expect(sheet.getByTestId('diff')).toContainText('available to everyone again');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // Swipe left → "Delete for good" → always previewed (cannot be undone).
  await touchSwipe(page, abuse, -260, 0);
  await abuse.locator('[data-row-action="confirm"]').click();
  await expect(sheet.getByTestId('diff')).toContainText('This cannot be undone.');
  await sheet.getByTestId('action-confirm').click();
  await expect(rows).toHaveCount(1);
  const log = (await serverLog(page)).log.map((l) => l.id);
  expect(log).toContain('media.release-quarantine');
  expect(log).toContain('media.confirm-quarantine');
});

test('file details: lens with tier and owners, team notes', async ({ page }) => {
  await page.goto('/admin/media');
  await page.getByTestId('media-tile').first().click();
  const sheet = page.getByTestId('file-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('file-lens').getByTestId('item-lens').click();
  const lens = sheet.getByTestId('item-lens-details');
  await expect(lens).toContainText('sha256 1111');
  await expect(lens).toContainText('mime image/png');
  await expect(lens).toContainText('tier hot');
  await expect(lens).toContainText('owners 2');

  await expect(sheet.getByTestId('file-notes')).toContainText('No notes yet');
  await sheet.getByTestId('file-note-input').fill('Checked: this is the relay logo');
  await sheet.getByTestId('file-note-add').click();
  await expect(sheet.getByTestId('file-note')).toHaveText(/Checked: this is the relay logo/);
  expect((await serverLog(page)).log.map((l) => l.id)).toContain('notes.add');
});

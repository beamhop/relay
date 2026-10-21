// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone: People bulk actions, "Why?" on blocks, row lens, notes; Security owners, checklist and API tokens. */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { reset, serverLog, signedIn, touchSwipe } from './helpers.ts';

/** Real touch long-press (CDP touch events → pointer events). */
async function longPress(page: Page, target: Locator, ms = 700): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('long-press target not visible');
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 30);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('People', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
    await reset(page, true);
    await page.goto('/admin/people');
    await expect(page.getByTestId('user-row')).toHaveCount(3);
  });

  test('long-press selects, swipe is off while selecting, bulk mute with one undo', async ({
    page,
  }) => {
    const rows = page.getByTestId('user-row');
    await longPress(page, rows.first().locator('button', { hasText: 'GB left' }));
    await expect(page.getByTestId('users-list')).toHaveAttribute('data-selecting', 'true');
    await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
    await expect(page.getByTestId('user-sheet')).toBeHidden();
    // Selection mode turns swipe actions off.
    await expect(page.locator('[data-row-actions]')).toHaveCount(0);
    await rows.nth(1).getByTestId('user-pick').click();
    await expect(page.getByTestId('bulk-count')).toHaveText('2 selected');

    await page.getByTestId('bulk-mute').click();
    const sheet = page.getByTestId('bulk-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('2 accounts will be muted');
    await sheet.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('toast').first()).toContainText(
      'Mute account: done for 2 people',
    );
    await expect(page.getByTestId('users-list').getByText('Muted', { exact: true })).toHaveCount(2);
    await expect(page.getByTestId('people-select')).toHaveText('Select');
    // Swipe actions are back.
    await expect(page.locator('[data-row-actions]')).toHaveCount(3);
    const log = await serverLog(page);
    expect(log.log.filter((l) => l.id === 'moderation.mute-pubkey')).toHaveLength(2);

    await page.getByTestId('toast-undo').first().click();
    await expect(page.getByTestId('users-list').getByText('Muted', { exact: true })).toHaveCount(0);
  });

  test('bulk plan change previews everyone and one undo reverts all', async ({ page }) => {
    await page.getByTestId('people-select').click();
    await page.getByTestId('people-select-all').click();
    await expect(page.getByTestId('bulk-count')).toHaveText('3 selected');
    await page.getByTestId('bulk-tier').click();
    const sheet = page.getByTestId('bulk-sheet');
    await sheet.locator('[data-tier="default"]').click();
    await expect(sheet.getByTestId('diff').locator('li')).toHaveCount(3);
    await expect(sheet.getByTestId('diff')).toContainText('moves to default');
    await sheet.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('toast').first()).toContainText('Change plan: done for 3 people');
    let log = await serverLog(page);
    expect(log.log.filter((l) => l.id === 'users.set-tier')).toHaveLength(3);
    await page.getByTestId('toast-undo').first().click();
    await expect(page.getByTestId('toast').last()).toContainText('Undone for everyone');
    log = await serverLog(page);
    expect(log.log.filter((l) => l.id === 'undo')).toHaveLength(3);
  });

  test('blocked people get "Why?"; rows have a technical lens; notes in the sheet', async ({
    page,
  }) => {
    const rows = page.getByTestId('user-row');
    await expect(page.getByTestId('why-button')).toHaveCount(0);
    await page.getByTestId('people-select').click();
    await rows.first().getByTestId('user-pick').click();
    await page.getByTestId('bulk-ban').click();
    await expect(page.getByTestId('bulk-sheet').getByTestId('diff')).toContainText(
      '1 accounts will be blocked',
    );
    await page.getByTestId('bulk-apply').click();
    await expect(rows.first().getByText('Blocked', { exact: true })).toBeVisible();
    expect((await serverLog(page)).bans).toEqual(['c'.repeat(64)]);

    await rows.first().getByTestId('why-button').click();
    await expect(page.getByTestId('why-answer')).toBeVisible();
    await page.keyboard.press('Escape');

    await rows.nth(1).getByTestId('item-lens').click();
    const lens = rows.nth(1).getByTestId('item-lens-details');
    await expect(lens).toContainText('npub1');
    await expect(lens).toContainText(`hex ${'d'.repeat(64)}`);
    await expect(lens).toContainText('quotaBytes 5368709120');
    await expect(lens).toContainText('tier default');

    // Notes on a person.
    await rows.first().locator('button', { hasText: 'GB left' }).click();
    const userSheet = page.getByTestId('user-sheet');
    await expect(userSheet.getByTestId('why-button')).toBeVisible();
    await expect(userSheet.getByTestId('person-notes')).toContainText('No notes yet.');
    await userSheet.getByTestId('note-input').fill('Spammed the welcome thread');
    await userSheet.getByTestId('note-add').click();
    await expect(userSheet.getByTestId('note')).toContainText('Spammed the welcome thread');
  });

  test('swipe row actions still work', async ({ page }) => {
    const row = page.getByTestId('user-row').first();
    await touchSwipe(page, row, -220, 0);
    await row.locator('[data-row-action="mute"]').click();
    await expect(page.getByTestId('toast').first()).toContainText('Muted 1 account');
  });
});

test.describe('Security', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
    await reset(page, true);
  });

  test('recovery checklist, add a second owner with a clear warning', async ({ page }) => {
    await page.goto('/admin/settings/security');
    const check = page.getByTestId('recovery-checklist');
    await expect(check.locator('[data-check="owner"]')).toHaveAttribute('data-done', 'false');
    await expect(page.getByTestId('owner-row')).toHaveCount(1);
    await expect(page.getByTestId('owners')).toContainText('You are the only owner');

    await page.getByTestId('add-owner').click();
    const sheet = page.getByTestId('action-sheet');
    await sheet.locator('[data-setting-field="pubkey"] input').fill('f'.repeat(64));
    await sheet.locator('[data-setting-field="displayName"] input').fill('Deniz');
    await sheet.getByTestId('action-continue').click();
    await expect(sheet.getByTestId('diff')).toContainText('Deniz will become an owner');
    await expect(sheet.getByTestId('diff')).toContainText(
      'They will be able to do everything you can, including removing you',
    );
    await sheet.getByTestId('action-confirm').click();
    await expect(page.getByTestId('owner-row')).toHaveCount(2);
    await expect(page.getByTestId('owners')).toContainText('Deniz');
    await expect(check.locator('[data-check="owner"]')).toHaveAttribute('data-done', 'true');
  });

  test('API tokens: plain scopes, swipe to revoke with undo, create shows the secret once', async ({
    page,
  }) => {
    await page.goto('/admin/settings/security');
    const rows = page.getByTestId('token-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Backup script');
    await expect(rows.first()).toContainText('see everything, moderate posts and people');
    await expect(rows.first()).toContainText('last used');
    await rows.first().getByTestId('item-lens').click();
    await expect(rows.first().getByTestId('item-lens-details')).toContainText(
      'scopes relay.read moderation.write',
    );

    await touchSwipe(page, rows.first(), -200, 0);
    await rows.first().locator('[data-row-action="revoke"]').click();
    await expect(page.getByTestId('toast').first()).toContainText('Revoked API token');
    await expect(rows).toHaveCount(0);
    await page.getByTestId('toast-undo').first().click();
    await expect(rows).toHaveCount(1);

    await page.getByTestId('token-create').click();
    const sheet = page.getByTestId('action-sheet');
    await sheet.locator('[data-setting-field="name"] input').fill('CI deploys');
    await sheet.getByTestId('action-continue').click();
    await sheet.getByTestId('action-confirm').click();
    await expect(sheet.getByTestId('action-secret')).toContainText('bh_');
    await page.keyboard.press('Escape');
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('token-list')).toContainText('CI deploys');
  });
});

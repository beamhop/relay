// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop parity (§6.14): sidebar, split panes, ⌘K palette, keyboard triage. Runs at 1440×900. */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

test.beforeEach(async ({ page }) => {
  await reset(page, true);
  await signedIn(page);
});

test('sidebar navigation replaces the tab bar', async ({ page }) => {
  await page.goto('/admin/');
  await expect(page.getByTestId('health-score')).toHaveText('92');
  await expect(page.getByTestId('tab-bar')).toBeHidden();
  await expect(page.getByTestId('fab')).toBeHidden();
  const side = page.getByTestId('sidebar');
  await expect(side).toBeVisible();
  for (const [name, url] of [
    ['Activity', /\/admin\/activity$/],
    ['People', /\/admin\/people$/],
    ['Media', /\/admin\/media$/],
    ['Settings', /\/admin\/settings$/],
    ['Home', /\/admin\/?$/],
  ] as const) {
    await side.getByRole('link', { name }).click();
    await expect(page).toHaveURL(url);
    await expect(side.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
  }
});

test('review queue is a split pane: pick any item from the list', async ({ page }) => {
  await page.goto('/admin/activity?tab=queue');
  const list = page.getByTestId('queue-list');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('queue-list-item')).toHaveCount(3);
  await expect(page.getByTestId('queue-reason')).toContainText('#1');
  await list.getByTestId('queue-list-item').nth(2).click();
  await expect(page.getByTestId('queue-reason')).toContainText('#3');
  await expect(list.getByTestId('queue-list-item').first()).toHaveAttribute('aria-current', 'true');
  // List and card side by side.
  const lb = await list.boundingBox();
  const cb = await page.getByTestId('queue-card').boundingBox();
  expect(lb && cb && cb.x > lb.x + lb.width - 1).toBeTruthy();
});

test('⌘K opens the palette and jumps to a screen', async ({ page }) => {
  await page.goto('/admin/');
  await expect(page.getByTestId('health-score')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('goals');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/settings\/goals$/);
  await expect(palette).toBeHidden();
  // `g a` goes to Activity.
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/admin\/activity$/);
});

test('keyboard triage: x remove, j skip, e keep, u undo', async ({ page }) => {
  await page.goto('/admin/activity?tab=queue');
  await expect(page.getByTestId('queue-count')).toHaveText('3 to review');
  await page.keyboard.press('x');
  await expect(page.getByTestId('queue-count')).toHaveText('2 to review');
  await expect(page.getByTestId('queue-reason')).toContainText('#2');
  await page.keyboard.press('j'); // skip → #3 first
  await expect(page.getByTestId('queue-reason')).toContainText('#3');
  await page.keyboard.press('e'); // keep #3
  await expect(page.getByTestId('queue-count')).toHaveText('1 to review');
  await page.keyboard.press('u'); // undo keep
  await expect(page.getByTestId('queue-count')).toHaveText('2 to review');
  const ids = (await serverLog(page)).log.map((l) => l.id);
  expect(ids).toEqual(['moderation.remove', 'moderation.keep', 'undo']);
});

test('keyboard dismisses the Home card (e), assistant opens as a side panel', async ({ page }) => {
  await reset(page, true, { ai: 'on' });
  await page.goto('/admin/');
  await expect(page.getByTestId('attention-card')).toContainText('Spam wave');
  await page.keyboard.press('e');
  await expect(page.getByTestId('inbox-zero')).toBeVisible();

  await page.getByTestId('assistant-open').click();
  const panel = page.getByTestId('assistant');
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box && box.x > 900 && box.height > 800).toBeTruthy();
  await page.keyboard.type('Anything to change?');
  await page.keyboard.press('Enter');
  await expect(panel.getByTestId('assistant-proposal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

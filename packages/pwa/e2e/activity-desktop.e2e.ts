// SPDX-License-Identifier: AGPL-3.0-or-later
/** Activity tab on desktop: checkboxes + shift-click selection, AI hints in the list, logs, on-call. */
import { type Page, expect, test } from '@playwright/test';
import { serverLog, signedIn } from './helpers.ts';

async function resetActivity(page: Page, opts: Record<string, unknown> = {}) {
  await page.request.post('/__reset', { data: { claimed: true, ai: 'absent', ...opts } });
  await signedIn(page);
}

test('queue: shift-click selects a range from the list, then keep all', async ({ page }) => {
  await resetActivity(page, { ai: 'on' });
  await page.goto('/admin/activity?tab=queue');
  const list = page.getByTestId('queue-list');
  await expect(list.getByTestId('queue-list-item').first()).toContainText('Suggested: spam');
  await list.getByTestId('queue-list-check').first().click();
  await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
  await page
    .getByTestId('queue-select-item')
    .nth(2)
    .click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('bulk-count')).toHaveText('3 selected');
  await page.getByTestId('bulk-keep').click();
  await page.getByTestId('bulk-apply').click();
  await expect(page.getByTestId('queue-empty')).toBeVisible();
  expect((await serverLog(page)).log.filter((l) => l.id === 'moderation.keep')).toHaveLength(3);
});

test('stream: checkboxes select posts without a long-press', async ({ page }) => {
  await resetActivity(page, { activityLive: true });
  await page.goto('/admin/activity');
  const checks = page.getByTestId('stream-check');
  await expect(checks).toHaveCount(2);
  await checks.first().click();
  await checks.nth(1).click();
  await expect(page.getByTestId('bulk-count')).toHaveText('2 selected');
  await page.getByTestId('bulk-remove').click();
  await expect(page.getByTestId('bulk-sheet').getByTestId('diff')).toContainText('Move 2 posts');
  await page.getByTestId('bulk-apply').click();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});

test('logs and on-call screen render with desktop parity', async ({ page }) => {
  await resetActivity(page, { alertChannel: true });
  await page.goto('/admin/activity?tab=logs');
  await expect(page.getByTestId('log-line')).toHaveCount(2);
  await page.getByTestId('logs-source').selectOption('blossom');
  await expect(page.getByTestId('log-line')).toHaveCount(1);
  await page.goto('/admin/activity/on-call');
  await expect(page.getByRole('heading', { name: 'On-call schedule' })).toBeVisible();
  await expect(page.getByTestId('oncall-add')).toBeVisible();
});

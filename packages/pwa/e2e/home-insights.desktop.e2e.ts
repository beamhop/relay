// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop parity for Insights, the launch kit and goal override markers (1440×900). */
import { expect, test } from '@playwright/test';
import { reset, signedIn } from './helpers.ts';

const AUTH = { authorization: 'Bearer session-token' };

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('Insights: Home link, wide grid, lens shows technical names', async ({ page }) => {
  await reset(page, true);
  await page.goto('/admin/');
  await page.getByTestId('home-insights-link').click();
  await expect(page).toHaveURL(/\/admin\/insights$/);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  const stats = page.getByTestId('insights-live');
  await expect(stats.getByTestId('stat-p50')).toContainText('3 ms');
  await expect(stats.getByTestId('stat-error-rate')).toContainText('0%');
  // Four stats in one row at desktop width.
  const a = await stats.getByTestId('stat-connections').boundingBox();
  const b = await stats.getByTestId('stat-reads').boundingBox();
  expect(a && b && Math.abs(a.y - b.y) < 2).toBe(true);
  await expect(page.getByTestId('insights-reasons')).not.toContainText('rate-limited');

  await page.goto('/admin/settings');
  await page.getByTestId('lens-toggle').click();
  await page.goto('/admin/insights');
  await expect(page.getByTestId('insights-reasons')).toContainText(
    'events.rejected{reason="rate-limited"}',
  );
});

test('Media links to the storage part of Insights; launch kit at desktop width', async ({
  page,
}) => {
  await reset(page, true, { host: 'relay.example.com' });
  await page.goto('/admin/media');
  await page.getByTestId('insights-link').click();
  await expect(page).toHaveURL(/\/admin\/insights#storage$/);
  await expect(page.getByTestId('stat-files')).toBeVisible();

  await page.goto('/admin/launch');
  await expect(page.getByTestId('launch-relay-url')).toHaveText('wss://relay.example.com');
  await expect(page.getByTestId('launch-polish').getByTestId('polish-item')).toHaveCount(2);
});

test('goals: "values changed by you" next to the slider', async ({ page }) => {
  await reset(page, true);
  const api = '/api/v1/nodes/self/relays/main/config';
  const prop = await (
    await page.request.post(`${api}/propose`, {
      headers: AUTH,
      data: { merge: { limits: { maxEventBytes: 4096 } } },
    })
  ).json();
  await page.request.post(`${api}/commit`, { headers: AUTH, data: { proposalId: prop.id } });
  await page.goto('/admin/settings/goals');
  await expect(page.getByTestId('goal-overrides')).toHaveText('1 value changed by you');
  await page.getByTestId('goal-exact').locator('summary').click();
  await expect(page.locator('[data-testid="exact-row"][data-field="maxEventBytes"]')).toContainText(
    'Changed by you',
  );
});

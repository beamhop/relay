// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone: Home "Why?", Insights, launch kit, "Your week" and goal override markers. */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

const AUTH = { authorization: 'Bearer session-token' };

test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

test('Home: "Why?" on the health ring, a tile and the attention card; card lens', async ({
  page,
}) => {
  await reset(page, true);
  await page.goto('/admin/');
  await expect(page.getByTestId('health-score')).toHaveText('92');

  await page.locator('#health-title').locator('..').getByTestId('why-button').click();
  const sheet = page.getByTestId('why-answer');
  await expect(sheet).toContainText('Disk 82% full');
  await page.keyboard.press('Escape');

  await page.getByTestId('tile-connections').locator('..').getByTestId('why-button').click();
  await expect(sheet).toContainText('Right now: 12');
  await page.keyboard.press('Escape');

  const card = page.getByTestId('attention-card');
  await card.getByTestId('why-button').click();
  await expect(sheet).toContainText('Many posts from new accounts');
  await page.keyboard.press('Escape');
  await card.getByTestId('item-lens').click();
  await expect(card.getByTestId('item-lens-details')).toContainText('card batch:main:spam-wave');

  const whys = (await serverLog(page)).log.filter((l) => l.id === 'experience.why');
  expect(whys.map((w) => (w.input as { subject: string }).subject)).toEqual([
    'health',
    'metric',
    'card',
  ]);
});

test('Home tile opens Insights: live ops and community with plain names', async ({ page }) => {
  await reset(page, true);
  await page.goto('/admin/');
  await page.getByTestId('tile-events').click();
  await page.getByTestId('tile-open-insights').click();
  await expect(page).toHaveURL(/\/admin\/insights#live$/);

  const live = page.getByTestId('insights-live');
  await expect(live.getByTestId('stat-connections')).toContainText('12');
  await expect(live.getByTestId('stat-accept')).toContainText('75%');
  await expect(live.getByTestId('stat-p95')).toContainText('42 ms');
  const reasons = page.getByTestId('reason-row');
  await expect(reasons).toHaveCount(2);
  await expect(reasons.first()).toContainText('Posting too fast');
  await expect(
    page.getByTestId('chart-events').getByTestId('detail-chart').locator('svg').first(),
  ).toBeVisible();
  await expect(page.getByTestId('stat-db')).toContainText('5');
  await expect(page.getByTestId('stat-files')).toContainText('14 files');

  const community = page.getByTestId('insights-community');
  await expect(community.getByTestId('stat-dau')).toContainText('38');
  await expect(community.getByTestId('kind-row').first()).toContainText('Posts');
  // Technical names stay in the lens.
  await expect(community.getByTestId('insights-kinds')).not.toContainText('kind 1');
  await community.getByTestId('kind-row').first().getByTestId('item-lens').click();
  await expect(community.getByTestId('kind-row').first()).toContainText('kind 1');
  await expect(community.getByTestId('app-row')).toHaveCount(2);
  await expect(community.getByTestId('cohort-row')).toHaveCount(3);
  await expect(community.getByTestId('geo-row').first()).toContainText('Germany');
  await expect(community.getByTestId('storage-user-row').first()).not.toContainText('b'.repeat(64));

  await community.getByTestId('stat-mau').getByTestId('why-button').click();
  await expect(page.getByTestId('why-answer')).toContainText('no explanation for');
});

test('People links to the community part of Insights', async ({ page }) => {
  await reset(page, true);
  await page.goto('/admin/people');
  await page.getByTestId('insights-link').click();
  await expect(page).toHaveURL(/\/admin\/insights#community$/);
  await expect(page.getByTestId('insights-community')).toBeVisible();
});

test('launch kit: address, QR, copyable post, polish links and test my relay', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await reset(page, true, { host: 'relay.example.com' });
  await page.goto('/admin/');
  await page.getByTestId('checklist-launch-test-relay').click();
  await expect(page).toHaveURL(/\/admin\/launch$/);

  await expect(page.getByTestId('launch-relay-url')).toHaveText('wss://relay.example.com');
  await expect(page.getByTestId('launch-address').getByTestId('qr')).toBeVisible();
  await expect(page.getByTestId('launch-post')).toContainText(
    'Add it to your client: wss://relay.example.com',
  );
  await page.getByTestId('launch-copy-post').click();
  await expect(page.getByTestId('toast')).toContainText('Copied');

  const icon = page.locator('[data-testid="polish-item"][data-field="icon"]');
  await expect(icon).toContainText('Add an icon');
  await expect(icon).not.toContainText('NIP-11');
  await page.getByTestId('launch-test-run').click();
  await expect(page.getByTestId('test-relay-result')).toBeVisible();
  const log = (await serverLog(page)).log.map((l) => l.id);
  expect(log).toContain('experience.launch-kit');
  expect(log).toContain('experience.test-relay');
  // The announcement is never posted.
  expect(log.some((id) => id.includes('publish'))).toBe(false);
});

test('launch kit without a domain points to the domain settings', async ({ page }) => {
  await reset(page, true);
  await page.goto('/admin/launch');
  const nd = page.getByTestId('launch-needs-domain');
  await expect(nd).toContainText('Add your web address first');
  await expect(nd.getByRole('link')).toHaveAttribute('href', '/admin/settings/domains');
  await expect(page.locator('[data-testid="polish-item"]')).toHaveCount(2);
});

test('"Your week" on Home is dismissible', async ({ page }) => {
  await reset(page, true);
  await page.goto('/admin/');
  const week = page.getByTestId('my-week');
  await expect(week).toContainText('7 min managing your relay');
  await expect(week).toContainText('5 things done');
  await expect(week).toContainText('about 6 min saved by suggestions');
  await expect(week).toContainText('Never sent anywhere');
  await week.getByTestId('my-week-hide').click();
  await expect(week).toBeHidden();
  await page.reload();
  await expect(page.getByTestId('health-score')).toHaveText('92');
  await expect(page.getByTestId('my-week')).toBeHidden();
});

test('goals: overridden values are marked and can go back to the goal', async ({ page }) => {
  await reset(page, true);
  // An admin overrode one exact limit in Advanced.
  const api = '/api/v1/nodes/self/relays/main/config';
  const prop = await (
    await page.request.post(`${api}/propose`, {
      headers: AUTH,
      data: { merge: { limits: { eventsPerMinute: 5 } } },
    })
  ).json();
  await page.request.post(`${api}/commit`, { headers: AUTH, data: { proposalId: prop.id } });

  await page.goto('/admin/settings/goals');
  const marker = page.getByTestId('goal-overrides');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText('1 value changed by you');
  await marker.click();
  const row = page.locator('[data-testid="exact-row"][data-field="eventsPerMinute"]');
  await expect(row).toHaveAttribute('data-source', 'override');
  await expect(row).toContainText('Changed by you');
  await expect(row).toContainText('Your goal would set');
  const goalRow = page.locator('[data-testid="exact-row"][data-source="goal"]').first();
  await expect(goalRow).toContainText('From your');

  await row.getByTestId('goal-revert').click();
  await page.getByTestId('config-apply').click();
  await expect(page.getByTestId('goal-overrides')).toHaveCount(0);
  const relay = (await serverLog(page)).relay as unknown as { limits: Record<string, unknown> };
  expect(relay.limits.eventsPerMinute).toBeUndefined();
});

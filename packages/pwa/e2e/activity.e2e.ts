// SPDX-License-Identifier: AGPL-3.0-or-later
/** Activity tab on a phone: AI hints, bulk actions, refused posts, alerts, on-call, notes, logs. */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { serverLog, signedIn } from './helpers.ts';

const SPAMMER = 'b'.repeat(64);

async function resetActivity(page: Page, opts: Record<string, unknown> = {}) {
  await page.request.post('/__reset', { data: { claimed: true, ai: 'absent', ...opts } });
  await signedIn(page);
}

async function activityState(page: Page) {
  return (await page.request.get('/__activity')).json() as Promise<{
    removed: string[];
    mutes: Array<{ rule: string; until: number | null }>;
    schedule: { rotation: Array<{ principalId: string }> } | null;
    notes: Array<{ text: string }>;
    dismissed: string[];
  }>;
}

/** Touch-and-hold (Chromium CDP touch events). */
async function longPress(page: Page, target: Locator, ms = 750) {
  const box = await target.boundingBox();
  if (!box) throw new Error('long-press target not visible');
  const x = box.x + Math.min(box.width / 2, 120);
  const y = box.y + Math.min(box.height / 2, 40);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('review queue', () => {
  test('shows AI suggestions as hints only when the AI module is on', async ({ page }) => {
    await resetActivity(page, { ai: 'on' });
    await page.goto('/admin/activity?tab=queue');
    const hint = page.getByTestId('queue-ai-hint');
    await expect(hint).toContainText('Suggested: spam');
    await expect(hint).toContainText('repeated link to a follower shop');
    await expect(hint).toContainText('Nothing happens unless you decide');
    // Never applied by itself.
    expect((await serverLog(page)).log).toHaveLength(0);

    await resetActivity(page, { ai: 'absent' });
    await page.goto('/admin/activity?tab=queue');
    await expect(page.getByTestId('queue-reason')).toContainText('#1');
    await expect(page.getByTestId('queue-ai-hint')).toHaveCount(0);
  });

  test('long-press selects; remove selected shows the diff, applies and undoes', async ({
    page,
  }) => {
    await resetActivity(page);
    await page.goto('/admin/activity?tab=queue');
    await expect(page.getByTestId('queue-count')).toHaveText('3 to review');
    await longPress(page, page.getByTestId('queue-card'));
    await expect(page.getByTestId('bulk-bar')).toBeVisible();
    await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
    await page.getByTestId('queue-select-item').nth(1).click();
    await expect(page.getByTestId('bulk-count')).toHaveText('2 selected');

    await page.getByTestId('bulk-remove').click();
    const sheet = page.getByTestId('bulk-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('Move 2 posts to the recycle bin');
    await sheet.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('toast').first()).toContainText('Moved 2 posts');
    await expect(page.getByTestId('queue-count')).toHaveText('1 to review');
    const run = (await serverLog(page)).log.find((l) => l.id === 'moderation.bulk-delete');
    expect((run?.input as { eventIds: string[] }).eventIds).toHaveLength(2);

    await page.getByTestId('toast-undo').click();
    await expect.poll(async () => (await activityState(page)).removed.length).toBe(0);
  });

  test('two-person rule: removing waits for a second admin', async ({ page }) => {
    await resetActivity(page, { twoPerson: true });
    await page.goto('/admin/activity?tab=queue');
    await page.getByTestId('queue-select').click();
    await page.getByTestId('queue-select-item').first().click();
    await page.getByTestId('bulk-remove').click();
    await expect(page.getByTestId('bulk-sheet').getByTestId('diff')).toContainText(
      'Another admin must approve',
    );
    await page.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('toast').first()).toContainText(
      'Sent to another admin for approval',
    );
    await expect(page.getByTestId('queue-count')).toHaveText('3 to review');
    expect((await activityState(page)).removed).toHaveLength(0);
  });

  test('keep selected runs as one bulk request with one undo', async ({ page }) => {
    await resetActivity(page);
    await page.goto('/admin/activity?tab=queue');
    await page.getByTestId('queue-select').click();
    await page.getByTestId('queue-select-item').nth(0).click();
    await page.getByTestId('queue-select-item').nth(2).click();
    await page.getByTestId('bulk-keep').click();
    await expect(page.getByTestId('bulk-sheet').getByTestId('diff')).toContainText('2 items');
    await page.getByTestId('bulk-apply').click();
    await expect(page.getByTestId('queue-count')).toHaveText('1 to review');
    expect((await serverLog(page)).log.filter((l) => l.id === 'moderation.keep')).toHaveLength(2);
    await page.getByTestId('toast-undo').click();
    await expect(page.getByTestId('toast').first()).toContainText('Undone');
  });
});

test.describe('live stream', () => {
  test('long-press a post, then block its author', async ({ page }) => {
    await resetActivity(page, { activityLive: true });
    await page.goto('/admin/activity');
    const rows = page.getByTestId('stream-row');
    await expect(rows).toHaveCount(2);
    await longPress(page, rows.first());
    await expect(page.getByTestId('bulk-count')).toHaveText('1 selected');
    await page.getByTestId('bulk-ban').click();
    await expect(page.getByTestId('bulk-sheet').getByTestId('diff')).toContainText(
      '1 accounts will be blocked',
    );
    await page.getByTestId('bulk-apply').click();
    await expect.poll(async () => (await serverLog(page)).bans).toEqual([SPAMMER]);
  });

  test('refused posts each have "Why?" and team notes', async ({ page }) => {
    await resetActivity(page);
    await page.goto('/admin/activity');
    await page.getByTestId('filter-refused').click();
    const rows = page.getByTestId('refused-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('blocked word');
    await expect(rows.first().getByTestId('why-button')).toBeVisible();

    await rows.first().getByTestId('notes-button').click();
    const sheet = page.getByTestId('notes-sheet');
    await expect(sheet).toContainText('Only admins can see these');
    await sheet.getByTestId('notes-input').fill('Known spammer, see report #12');
    await sheet.getByTestId('notes-add').click();
    await expect(sheet.getByTestId('notes-list')).toContainText('Known spammer');
    expect((await activityState(page)).notes.map((n) => n.text)).toEqual([
      'Known spammer, see report #12',
    ]);
    await page.keyboard.press('Escape');
    await expect(rows.first().getByTestId('notes-count')).toHaveText('1');
  });
});

test.describe('alerts', () => {
  test('snooze, mute and turn back on; every alert has "Why?"', async ({ page }) => {
    await resetActivity(page);
    await page.goto('/admin/activity?tab=alerts');
    const rows = page.getByTestId('alert-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByTestId('why-button')).toBeVisible();
    await expect(rows.nth(1).getByTestId('why-button')).toBeVisible();

    await rows.first().getByTestId('alert-snooze').click();
    await rows.first().getByTestId('alert-snooze-1h').click();
    await expect(rows.first().getByTestId('alert-muted')).toContainText('Snoozed until');
    expect((await activityState(page)).mutes[0]?.until).not.toBeNull();

    await rows.first().getByTestId('alert-unmute').click();
    await expect(rows.first().getByTestId('alert-muted')).toHaveCount(0);

    await rows.nth(1).getByTestId('alert-mute').click();
    await expect(rows.nth(1).getByTestId('alert-muted')).toContainText('Muted');
    expect((await activityState(page)).mutes).toMatchObject([{ rule: 'disk-fill', until: null }]);
  });

  test('tip can be hidden; digest frequency is a safe change', async ({ page }) => {
    await resetActivity(page);
    await page.goto('/admin/activity?tab=alerts');
    await expect(page.getByTestId('alerts-tip')).toBeVisible();
    await page.getByTestId('alerts-tip-hide').click();
    await expect(page.getByTestId('alerts-tip')).toHaveCount(0);
    expect((await activityState(page)).dismissed).toHaveLength(1);

    await expect(page.getByTestId('digest-state')).toContainText('Every day');
    await page.getByTestId('digest-row').click();
    const sheet = page.getByTestId('digest-sheet');
    await sheet.getByTestId('digest-weekly').click();
    await sheet.getByTestId('digest-save').click();
    await expect(page.getByTestId('diff')).toContainText('weekly');
    await page.getByTestId('config-apply').click();
    await expect(page.getByTestId('digest-state')).toContainText('Every week');
  });

  test('on-call: assign a turn and see who is on call now', async ({ page }) => {
    await resetActivity(page, { alertChannel: true });
    await page.goto('/admin/activity?tab=alerts');
    await expect(page.getByTestId('oncall-now')).toContainText('Nobody is on call');
    await page.getByTestId('oncall-now').click();
    await expect(page).toHaveURL(/\/activity\/on-call$/);
    await expect(page.getByTestId('oncall-empty')).toBeVisible();
    await page.getByTestId('oncall-add').click();
    await page.getByTestId('oncall-picker').getByTestId('oncall-pick').first().click();
    await expect(page.getByTestId('oncall-name')).toHaveText('Owner');
    await expect(page.getByTestId('oncall-turn').first()).toContainText('This week');
    await page.getByTestId('oncall-save').click();
    await expect(page.getByTestId('diff')).toContainText('1 people take turns every 7 days');
    await page.getByTestId('action-confirm').click();
    await expect.poll(async () => (await activityState(page)).schedule?.rotation.length).toBe(1);
    await page.goto('/admin/activity?tab=alerts');
    await expect(page.getByTestId('oncall-now')).toContainText('On call now: Owner');
  });
});

test.describe('logs', () => {
  test('filters by level and text; lines open into their fields', async ({ page }) => {
    await resetActivity(page);
    await page.goto('/admin/activity?tab=logs');
    const lines = page.getByTestId('log-line');
    await expect(lines).toHaveCount(2); // errors + warnings by default
    await page.getByTestId('logs-level-info').click();
    await expect(lines).toHaveCount(3);
    await lines.first().getByRole('button').first().click();
    const fields = lines.first().getByTestId('item-lens-details');
    await expect(fields).toContainText('ip: ip:3fa1c2');
    await expect(page.getByTestId('logs-list')).not.toContainText(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    await page.getByTestId('logs-search').fill('slow');
    await expect(lines).toHaveCount(1);
    await expect(lines.first()).toContainText('Slow query');
    await page.getByTestId('logs-tail').click();
    await expect(page.getByTestId('logs-tail')).toHaveAttribute('aria-pressed', 'true');
  });
});

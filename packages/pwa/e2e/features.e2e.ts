// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone flows: assistant chat, card dismiss, alert channels, defensive links. */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

test.describe('assistant', () => {
  test('streams an answer and applies a suggestion only on Approve, with undo', async ({
    page,
  }) => {
    await reset(page, true, { ai: 'on' });
    await signedIn(page);
    await page.goto('/admin/');
    await expect(page.getByTestId('attention-card')).toBeVisible();
    const fab = page.getByTestId('fab');
    await expect(fab).toHaveAttribute('data-mode', 'assistant');
    await fab.click();

    const panel = page.getByTestId('assistant');
    await expect(panel).toBeVisible();
    await panel.getByTestId('assistant-input').fill('How are we doing?');
    await panel.getByTestId('assistant-send').click();

    await expect(panel.getByTestId('assistant-question')).toHaveText('How are we doing?');
    await expect(panel.getByTestId('assistant-text')).toContainText(
      'Your relay is healthy. One account is sending spam',
    );
    await expect(panel.getByTestId('assistant-tool')).toContainText('Checked the relay health');
    // Plain by default: raw tool names only under the technical lens.
    await expect(panel.locator('[data-lens]')).toHaveCount(0);

    const card = panel.getByTestId('assistant-proposal');
    await expect(card.getByTestId('diff')).toContainText('1 account will be blocked');
    expect((await serverLog(page)).bans).toHaveLength(0); // nothing applied yet

    const sent = (await serverLog(page)).assistant[0];
    expect(sent?.message).toBe('How are we doing?');
    expect(sent?.context).toMatchObject({ screen: 'home', relayId: 'main', lens: 'simple' });
    expect((sent?.context as { selection?: { card?: string } }).selection?.card).toBe(
      'batch:main:spam-wave',
    );

    await card.getByTestId('proposal-approve').click();
    await expect(card.getByTestId('proposal-applied')).toContainText('Blocked 1 account');
    expect((await serverLog(page)).bans).toHaveLength(1);

    await page.getByTestId('toast-undo').click();
    await expect.poll(async () => (await serverLog(page)).bans.length).toBe(0);
    await expect(card).toContainText('Undone');
  });

  test('shows a clear "AI is off" state when the assistant is turned off', async ({ page }) => {
    await reset(page, true, { ai: 'off' });
    await signedIn(page);
    await page.goto('/admin/');
    await page.getByTestId('fab').click();
    const panel = page.getByTestId('assistant');
    await panel.getByTestId('assistant-input').fill('Hello?');
    await panel.getByTestId('assistant-send').click();
    const off = panel.getByTestId('assistant-off');
    await expect(off).toContainText('AI is off');
    await expect(off).toContainText('Settings › Privacy');
    await off.getByTestId('assistant-turn-on').click();
    await expect(page).toHaveURL(/\/admin\/settings\/privacy$/);
  });

  test('without the AI module the button keeps the command palette', async ({ page }) => {
    await reset(page, true);
    await signedIn(page);
    await page.goto('/admin/');
    await expect(page.getByTestId('fab')).toHaveAttribute('data-mode', 'palette');
    await page.getByTestId('fab').click();
    const palette = page.getByTestId('command-palette');
    await palette.getByRole('combobox').fill('assistant');
    await palette.getByRole('option', { name: 'Ask the assistant' }).click();
    await expect(page.getByTestId('assistant-off')).toContainText('AI is off');
  });
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await reset(page, true);
    await signedIn(page);
  });

  test('dismiss a Home card for good, then undo', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.getByTestId('attention-card')).toContainText('Spam wave');
    await page.getByTestId('card-dismiss').click();
    await expect(page.getByTestId('inbox-zero')).toBeVisible();
    await expect(page.getByTestId('toast')).toContainText('Dismissed');
    expect((await serverLog(page)).log.at(-1)?.id).toBe('experience.dismiss-card');
    await page.getByTestId('toast-undo').click();
    await expect(page.getByTestId('attention-card')).toContainText('Spam wave');
  });

  test('Home tiles draw inline sparklines; the detail chart loads on demand', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.getByTestId('tile-connections')).toBeVisible();
    await page.getByTestId('tile-events').click();
    // LayerChart is fetched only now, for the detail chart.
    await expect(page.getByTestId('detail-chart').locator('svg').first()).toBeVisible();
  });

  test('alert channels: add Telegram with only its fields, send a test, remove', async ({
    page,
  }) => {
    await page.goto('/admin/settings/alerts');
    const editor = page.getByTestId('alert-channels');
    await expect(editor.getByTestId('channels-empty')).toBeVisible();
    // The raw JSON field is gone; digest stays a simple setting.
    await expect(page.locator('[data-setting-field="alerts.channels"]')).toHaveCount(0);
    await expect(page.locator('[data-setting-field="alerts.digest"]')).toHaveCount(1);

    await editor.getByTestId('channel-add').click();
    const sheet = page.getByTestId('channel-sheet');
    for (const t of ['webpush', 'nostr-dm', 'telegram', 'discord', 'slack', 'email'])
      await expect(sheet.getByTestId(`channel-type-${t}`)).toBeVisible();
    await sheet.getByTestId('channel-type-telegram').click();
    await expect(sheet.locator('[data-channel-field]')).toHaveCount(2);
    await sheet.getByTestId('channel-review').click();
    await expect(sheet.getByRole('alert').first()).toContainText('Please fill this in');

    await sheet.locator('[data-channel-field="botToken"]').fill('123456:ABCDEFGHIJKLMNOP');
    await sheet.locator('[data-channel-field="chatId"]').fill('-100123');
    await sheet.getByTestId('channel-review').click();

    const diff = page.getByTestId('config-diff-sheet');
    await expect(diff.getByTestId('diff')).toBeVisible();
    await diff.getByTestId('config-apply').click();
    await expect(editor.getByTestId('channel-row')).toHaveCount(1);
    expect((await serverLog(page)).channels).toEqual([
      { type: 'telegram', id: 'telegram', botToken: '123456:ABCDEFGHIJKLMNOP', chatId: '-100123' },
    ]);

    await editor.getByTestId('channel-test').click();
    await expect(page.getByTestId('toast').last()).toContainText('Test message sent to telegram');
    expect((await serverLog(page)).tests).toEqual(['telegram']);

    await editor.getByRole('button', { name: 'Remove Telegram' }).click();
    await page.getByTestId('config-diff-sheet').getByTestId('config-apply').click();
    await expect(editor.getByTestId('channels-empty')).toBeVisible();
    expect((await serverLog(page)).channels).toEqual([]);
  });

  test('unknown links land on the nearest tab with a note', async ({ page }) => {
    await page.goto('/admin/settings/filters');
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(page.getByTestId('toast')).toHaveCount(1);
    await expect(page.getByTestId('toast')).toContainText('on Settings instead');

    await page.goto('/admin/people/admins');
    await expect(page).toHaveURL(/\/admin\/people\?tab=team$/);

    await page.goto('/admin/no/such/screen');
    await expect(page).toHaveURL(/\/admin\/?$/);
    await expect(page.getByTestId('toast')).toContainText('on Home instead');

    // A server checklist item naming a missing screen.
    await page.goto('/admin/');
    const item = page.getByTestId('setup-checklist').locator('a[data-fallback]');
    await expect(item).toContainText('Review blocked words');
    await item.click();
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(page.getByTestId('toast')).toContainText('on Settings instead');
  });
});

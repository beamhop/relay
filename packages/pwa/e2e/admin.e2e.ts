// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from '@playwright/test';
import { fakeExtension, reset, serverLog, signedIn, touchSwipe } from './helpers.ts';

test.describe('onboarding', () => {
  test('claim → persona → domain → done → recovery codes', async ({ page }) => {
    await reset(page, false);
    await fakeExtension(page);
    await page.goto('/admin/');
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'claim');
    await page.getByTestId('claim-code').fill('TEST-CODE-1234');
    await page.getByTestId('signin-extension').click();

    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'persona');
    // Company / Organization: company sign-in can be turned on right in the wizard.
    await page.getByTestId('persona-organization').click();
    await expect(page.getByTestId('org-intro')).toContainText('work account');
    await page.getByTestId('company-enable').click();
    await page.getByTestId('action-sheet').getByTestId('action-confirm').click();
    await expect(page.getByTestId('provider-google')).toBeVisible();
    await page.getByTestId('provider-microsoft').click();
    await expect(page.getByTestId('redirect-uri')).toContainText('/sso/entra/callback');
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByTestId('persona-wot-community').click();

    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'domain');
    await expect(page.getByTestId('tls-status')).toContainText('Looks good');
    await page.getByRole('button', { name: 'Skip' }).click();

    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'done');
    await expect(page.getByTestId('relay-url')).toContainText('ws://');
    await expect(page.getByTestId('qr')).toBeVisible();
    await page.getByTestId('done-next').click();

    await expect(page.getByTestId('recovery-codes')).toContainText('AAAA-BBBB-CCCC');
    await expect(page.getByTestId('wizard-finish')).toBeDisabled();
    await page.getByTestId('recovery-saved').check();
    await page.getByTestId('wizard-finish').click();

    await expect(page.getByTestId('health-score')).toHaveText('92');
    await expect(page.getByTestId('tab-bar')).toBeVisible();
    const s = await serverLog(page);
    expect(s.relay.persona).toBe('wot-community');
  });
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await reset(page, true);
    await signedIn(page);
  });

  test('swipe right approves an attention card (preview → confirm), then undo', async ({
    page,
  }) => {
    await page.goto('/admin/');
    const card = page.getByTestId('attention-card');
    await expect(card).toContainText('Spam wave');
    await touchSwipe(page, card, 260, 0);

    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('3 accounts will be blocked');
    await sheet.getByTestId('action-confirm').click();

    await expect(page.getByTestId('inbox-zero')).toBeVisible();
    expect((await serverLog(page)).bans).toHaveLength(1);
    await page.getByTestId('toast-undo').click();
    await expect(page.getByTestId('attention-card')).toContainText('Spam wave');
    expect((await serverLog(page)).bans).toHaveLength(0);
  });

  test('moderation swipe triage: remove, ban, keyboard keep, undo', async ({ page }) => {
    await page.goto('/admin/activity?tab=queue');
    await expect(page.getByTestId('queue-count')).toHaveText('3 to review');
    await expect(page.getByTestId('queue-reason')).toContainText('#1');

    await touchSwipe(page, page.getByTestId('queue-card'), -260, 0); // ← remove
    await expect(page.getByTestId('queue-count')).toHaveText('2 to review');
    await expect(page.getByTestId('toast')).toContainText('Removed');

    await touchSwipe(page, page.getByTestId('queue-card'), 0, -260); // ↑ block author
    await expect(page.getByTestId('queue-count')).toHaveText('1 to review');
    let s = await serverLog(page);
    expect(s.log.map((l) => l.id)).toEqual([
      'moderation.remove',
      'moderation.ban-pubkey',
      'moderation.remove',
    ]);
    expect(s.bans).toHaveLength(1);

    await page.getByTestId('toast-undo').last().click(); // undo the block + remove
    await expect(page.getByTestId('queue-count')).toHaveText('2 to review');
    s = await serverLog(page);
    expect(s.bans).toHaveLength(0);

    await page.keyboard.press('e'); // keep
    await expect(page.getByTestId('queue-count')).toHaveText('1 to review');
    expect((await serverLog(page)).log.at(-1)?.id).toBe('moderation.keep');
  });

  test('goal slider: live explanation, save with diff, then undo', async ({ page }) => {
    await page.goto('/admin/settings/goals');
    const thumb = page.locator('[data-goal="openness"] [role="slider"]');
    await thumb.focus();
    for (let i = 0; i < 30; i++) await thumb.press('ArrowLeft');
    await expect(page.getByTestId('goal-changes').locator('li').first()).toBeVisible();

    await page.getByTestId('goals-save').click();
    const sheet = page.getByTestId('config-diff-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('How open the relay is: 70 → 40');
    await sheet.getByTestId('config-apply').click();
    await expect(page.getByTestId('toast')).toBeVisible();
    expect((await serverLog(page)).relay.goals.openness).toBe(40);

    await page.getByTestId('toast-undo').click();
    await expect.poll(async () => (await serverLog(page)).relay.goals.openness).toBe(70);
  });

  test('command palette runs an action with a generated form, preview and result', async ({
    page,
  }) => {
    await page.goto('/admin/');
    await page.getByTestId('fab').click();
    const palette = page.getByTestId('command-palette');
    await palette.getByRole('combobox').fill('invite');
    await palette.getByRole('option', { name: /Create invite/ }).click();

    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.locator('[data-setting-field="maxUses"] input')).toHaveValue('1');
    await sheet.locator('[data-setting-field="maxUses"] input').fill('5');
    await sheet.getByTestId('action-continue').click();
    await expect(sheet.getByTestId('diff')).toContainText('A new invite for 5 people');
    await sheet.getByTestId('action-confirm').click();
    await expect(sheet.getByTestId('action-secret')).toContainText('INVITE1');
    await expect(page.getByTestId('toast')).toContainText('Invite created');
  });

  test('complexity budget: every simple settings screen shows at most 7 settings', async ({
    page,
  }) => {
    await page.goto('/admin/settings');
    await expect(page.getByTestId('section-access')).toBeVisible();
    const ids = await page
      .locator('[data-testid^="section-"]')
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-testid')?.replace('section-', '') ?? ''),
      );
    expect(ids.length).toBeGreaterThanOrEqual(6);
    for (const id of ids) {
      await page.goto(`/admin/settings/${id}`);
      const screen = page.getByTestId('simple-screen');
      await expect(screen).toBeVisible();
      const inputs = await screen.locator('[data-setting-input]').count();
      expect(inputs, id).toBeGreaterThan(0);
      expect(inputs, id).toBeLessThanOrEqual(7);
    }
    await page.goto('/admin/settings/goals');
    await expect(page.locator('[data-goal]')).toHaveCount(5);
  });

  test('technical lens toggles and persists', async ({ page }) => {
    await page.goto('/admin/settings/access');
    await expect(page.locator('[data-lens]')).toHaveCount(0);
    await page.goto('/admin/settings');
    await page.getByTestId('lens-toggle').click();
    await page.goto('/admin/settings/access');
    await expect(page.locator('[data-lens]').first()).toContainText('access.mode');
  });
});

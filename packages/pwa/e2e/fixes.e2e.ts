// SPDX-License-Identifier: AGPL-3.0-or-later
import { bytesToHex } from '@noble/hashes/utils.js';
/** Phone: fixes from user testing (brand link, key sign-in, plugins, palette, help, cards, checklist, quotas, company sign-in, toasts). */
import { expect, test } from '@playwright/test';
import { nip19 } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import { reset, serverLog, signedIn } from './helpers.ts';

test.describe('sign in with a private key', () => {
  test('nsec signs locally, never reaches the server; remember + unlock + forget', async ({
    page,
  }) => {
    await reset(page, true);
    const sk = generateSecretKey();
    const hex = bytesToHex(sk);
    const nsec = nip19.nsecEncode(sk);
    const leaks: string[] = [];
    page.on('request', (r) => {
      const blob = `${r.url()} ${JSON.stringify(r.headers())} ${r.postData() ?? ''}`;
      if (blob.includes(nsec) || blob.includes(hex)) leaks.push(r.url());
    });
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(msg.text()));

    await page.goto('/admin/');
    await expect(page.getByTestId('signin')).toBeVisible();
    await page.getByTestId('signin-key').click();
    const form = page.getByTestId('key-form');
    await expect(form.getByTestId('key-warning')).toContainText('safer');
    await form.getByTestId('key-input').fill('npub1zzzz');
    await form.getByTestId('key-submit').click();
    await expect(form.getByTestId('key-error')).toContainText('public key');

    await form.getByTestId('key-input').fill(nsec);
    await form.getByTestId('key-remember').check();
    await form.getByTestId('remember-password').fill('hunter22pass');
    await form.getByTestId('remember-confirm').fill('hunter22pass');
    await form.getByTestId('key-submit').click();
    await expect(page.getByTestId('health-score')).toHaveText('92', { timeout: 15_000 });

    const stored = await page.evaluate(() => localStorage.getItem('beamhop.localKey'));
    expect(stored).toContain('ncryptsec1');
    expect(stored).not.toContain(hex);

    // Next visit: unlock with the password (key kept only in memory once unlocked).
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    const unlock = page.getByTestId('signin-unlock');
    await expect(unlock).toBeVisible();
    await unlock.getByTestId('unlock-password').fill('wrong-password');
    await unlock.getByTestId('unlock-submit').click();
    await expect(unlock.getByTestId('key-error')).toContainText('Wrong password', {
      timeout: 15_000,
    });
    await unlock.getByTestId('unlock-password').fill('hunter22pass');
    await unlock.getByTestId('unlock-submit').click();
    await expect(page.getByTestId('health-score')).toHaveText('92', { timeout: 15_000 });

    await page.goto('/admin/settings/security');
    await page.getByTestId('forget-device').click();
    expect(await page.evaluate(() => localStorage.getItem('beamhop.localKey'))).toBeNull();
    await expect(page.getByTestId('device-key')).toContainText('No private key');

    expect(leaks).toEqual([]);
    expect(logs.some((l) => l.includes(nsec) || l.includes(hex))).toBe(false);
  });

  test('the claim wizard accepts a hex key too', async ({ page }) => {
    await reset(page, false);
    await page.goto('/admin/');
    await page.getByTestId('claim-code').fill('TEST-CODE-1234');
    await page.getByTestId('signin-key').click();
    await page.getByTestId('key-input').fill(bytesToHex(generateSecretKey()));
    await page.getByTestId('key-submit').click();
    await expect(page.getByTestId('onboarding')).toHaveAttribute('data-step', 'persona');
  });
});

test.describe('signed in', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
  });

  test('the logo goes Home', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/settings');
    await page.getByTestId('brand-home-mobile').click();
    await expect(page).toHaveURL(/\/admin\/?$/);
  });

  test('plugins: add turned off, review settings, turn on, safety switch, remove', async ({
    page,
  }) => {
    await reset(page, true, { tripped: true });
    await page.goto('/admin/settings/plugins');
    const safety = page.getByTestId('plugin-safety');
    await expect(safety).toContainText('turned off for safety');
    await expect(safety).toContainText('failed 5 times');

    const add = page.locator('[data-testid="plugin-available"][data-plugin="keyword-filter"]');
    await add.getByTestId('plugin-add').click();
    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('cannot read your data');
    await expect(sheet.getByTestId('diff')).not.toContainText('start checking');
    await sheet.getByTestId('action-confirm').click();

    const row = page.locator('[data-testid="plugin-installed"][data-plugin="keyword-filter"]');
    await expect(row).toHaveAttribute('data-enabled', 'false');
    await expect(row.getByTestId('plugin-review-hint')).toBeVisible();
    await expect(row.getByTestId('plugin-stats')).toContainText('Checks');

    // Settings form generated from the plugin's config schema (plain labels).
    await row.getByTestId('plugin-configure').click();
    const cfg = page.getByTestId('plugin-config-sheet');
    const select = cfg.locator('[data-setting-field="action"] select');
    await expect(select.locator('option')).toContainText([
      'Turn the post away',
      'Hide it quietly',
      'Hold it for review',
    ]);
    await select.selectOption('hold');
    await cfg.getByTestId('plugin-config-save').click();
    await expect(sheet.getByTestId('diff')).toContainText('action: "hold"');
    await sheet.getByTestId('action-confirm').click();
    await expect
      .poll(async () => (await serverLog(page)).plugins['keyword-filter']?.config)
      .toMatchObject({ action: 'hold' });

    await row.getByTestId('plugin-toggle').click();
    await sheet.getByTestId('action-confirm').click();
    await expect(row).toHaveAttribute('data-enabled', 'true');

    await safety.getByTestId('safety-turn-on').click();
    await sheet.getByTestId('action-confirm').click();
    await expect(page.getByTestId('plugin-safety')).toHaveCount(0);

    await row.getByTestId('plugin-remove').click();
    await sheet.getByTestId('action-confirm').click();
    await expect(row).toHaveCount(0);
    expect((await serverLog(page)).plugins['keyword-filter']).toBeUndefined();
  });

  test('command palette: icons, groups, recent and suggested, no raw ids', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/');
    await page.getByTestId('fab').click();
    const palette = page.getByTestId('command-palette');
    await expect(palette.getByTestId('palette-suggested')).toBeVisible();
    await expect(palette.getByTestId('palette-recent')).toHaveCount(0);
    await expect(palette.getByTestId('palette-group-moderation')).toContainText('Block account');
    await expect(palette.getByTestId('palette-group-plugins')).toBeVisible();
    await expect(palette.locator('[data-entry] svg').first()).toBeVisible();
    await expect(palette.getByText('moderation.ban-pubkey')).toHaveCount(0);

    await palette.getByRole('combobox').fill('plugins');
    await palette
      .getByRole('option', { name: /^Plugins/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/admin\/settings\/plugins$/);

    await page.getByTestId('fab').click();
    await expect(palette.getByTestId('palette-recent')).toContainText('Plugins');
  });

  test('settings help: plain option labels, irrelevant fields hidden, rich ⓘ sheet', async ({
    page,
  }) => {
    await reset(page, true);
    await page.goto('/admin/settings/access');
    const mode = page.locator('[data-setting-field="access.mode"] select');
    await expect(mode.locator('option')).toContainText([
      'Anyone can post',
      'Only people I approve',
      'People in my web of trust',
    ]);
    await expect(page.locator('[data-setting-field="access.wot.depth"]')).toHaveCount(0);
    await mode.selectOption('wot');
    await expect(page.locator('[data-setting-field="access.wot.depth"]')).toHaveCount(1);

    await page.locator('[data-setting-field="access.mode"] [data-info-button]').click();
    const info = page.getByTestId('info-sheet');
    await expect(info.getByTestId('info-example')).toContainText('web of trust');
    await expect(info.getByTestId('info-recommended')).toContainText('Keeps spam out');
    await expect(info).not.toContainText('No extra explanation');
    await expect(info.locator('[data-lens]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    // A setting without any explanation has no ⓘ at all.
    await expect(
      page.locator('[data-setting-field="access.authRequired.read"] [data-info-button]'),
    ).toHaveCount(0);
  });

  test('informational Home cards have no approve affordances', async ({ page }) => {
    await reset(page, true, { infoCard: true });
    await page.goto('/admin/');
    const card = page.getByTestId('attention-card');
    await expect(card).toContainText('Your relay is live');
    await expect(card.locator('[data-severity="info"]')).toHaveAttribute(
      'data-approvable',
      'false',
    );
    await expect(card.getByTestId('card-primary')).toHaveCount(0);
    await expect(page.getByText('Swipe right to approve')).toHaveCount(0);
    await expect(card.getByTestId('card-snooze')).toBeVisible();
  });

  test('checklist: failed and in-progress states; backups update after apply', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/');
    const list = page.getByTestId('setup-checklist');
    await expect(list.getByTestId('checklist-test-relay')).toHaveAttribute('data-state', 'failed');
    await expect(list.getByTestId('checklist-test-relay')).toContainText('could not connect');
    await expect(list.getByTestId('checklist-backups')).toHaveAttribute('data-state', 'todo');

    await list.getByTestId('checklist-backups').click();
    await expect(page).toHaveURL(/\/admin\/settings\/backups$/);
    await page.locator('[data-setting-field="backups.enabled"] [role="switch"]').click();
    await page.getByTestId('section-save').click();
    const review = page.getByTestId('config-diff-sheet');
    await review.getByTestId('config-apply').click();
    await expect(review).toBeHidden();

    await page.getByTestId('brand-home-mobile').click();
    const backups = page.getByTestId('setup-checklist').getByTestId('checklist-backups');
    await expect(backups).toHaveAttribute('data-state', 'in-progress');
    await expect(backups).toContainText('waiting for the first one');
    await expect(backups.locator('.animate-spin')).toBeVisible();
  });

  test('test my relay: friendly checklist, sends the page origin', async ({ page }) => {
    await reset(page, true, { host: 'relay.example.com' });
    await page.goto('/admin/');
    await page.getByTestId('setup-checklist').getByTestId('checklist-test-relay').click();
    const sheet = page.getByTestId('action-sheet');
    const result = sheet.getByTestId('test-relay-result');
    await expect(result.locator('[data-step="connect"]')).toHaveAttribute('data-status', 'pass');
    await expect(result.locator('[data-step="upload"]')).toContainText(
      'Uploading a file did not work',
    );
    await expect(result).not.toContainText('PUT /upload');
    await expect(sheet.getByTestId('action-output')).toHaveCount(0);
    const run = (await serverLog(page)).log.find((l) => l.id === 'experience.test-relay');
    expect((run?.input as { baseUrl?: string }).baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('test my relay without a domain explains and links to Domains', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/');
    await page.getByTestId('setup-checklist').getByTestId('checklist-test-relay').click();
    const needs = page.getByTestId('test-needs-domain');
    await expect(needs).toContainText('no public address');
    await needs.getByTestId('test-open-domains').click();
    await expect(page).toHaveURL(/\/admin\/settings\/domains$/);
    await expect(page.getByTestId('action-sheet')).toBeHidden();
  });

  test('quotas on People, the user sheet, Media and Goals', async ({ page }) => {
    await reset(page, true);
    await page.goto('/admin/people');
    const rows = page.getByTestId('user-row');
    await expect(rows.first().getByTestId('quota-text')).toHaveText('2.1 GB of 5 GB · 2.9 GB left');
    await expect(page.getByTestId('users-list').getByTestId('over-quota')).toHaveCount(1);
    await rows.first().locator('button', { hasText: 'GB left' }).click();
    await expect(page.getByTestId('user-sheet').getByTestId('user-quota')).toContainText(
      '2.9 GB left',
    );
    await page.keyboard.press('Escape');

    await page.goto('/admin/media?tab=usage');
    await expect(page.getByTestId('usage-over')).toHaveText('1');
    await expect(page.getByTestId('usage-near')).toHaveText('1');
    await expect(page.getByTestId('usage-largest').getByTestId('quota')).toHaveCount(2);

    await page.goto('/admin/settings/goals');
    const thumb = page.locator('[data-goal="storage"] [role="slider"]');
    await thumb.focus();
    for (let i = 0; i < 10; i++) await thumb.press('ArrowLeft');
    await expect(page.getByTestId('quota-impact')).toContainText(
      '3 people would be over their new storage limit',
    );
  });

  test('company sign-in: turn on, connect, test, map a group', async ({ page }) => {
    await reset(page, true, { persona: 'organization' });
    await page.goto('/admin/settings');
    await page.getByTestId('company-link').click();
    await expect(page).toHaveURL(/\/admin\/settings\/company$/);
    await page.getByTestId('company-enable').click();
    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('Company sign-in will be turned on');
    await sheet.getByTestId('action-confirm').click();

    await page.getByTestId('provider-google').click();
    await expect(page.getByTestId('redirect-uri')).toContainText('/api/v1/sso/google/callback');
    await expect(page.getByTestId('scim-token')).toHaveCount(0); // Google: no user sync token
    await page.getByTestId('client-id').fill('client-123');
    await page.getByTestId('client-secret').fill('s3cret');
    await page.getByTestId('domain').fill('example.com');
    await page.getByTestId('company-connect').click();
    await sheet.getByTestId('action-confirm').click();
    await expect.poll(async () => (await serverLog(page)).idp?.clientId).toBe('client-123');

    await page.getByTestId('company-test').click();
    await expect(page.getByTestId('company-test-result')).toHaveAttribute('data-ok', 'true');
    await expect(page.getByTestId('company-test-checks')).toContainText(
      'Sign-in provider answered',
    );

    await page.getByTestId('company-add-group').click();
    await sheet.locator('[data-setting-field="group"] input').fill('Engineering');
    await sheet.getByTestId('action-continue').click();
    await sheet.getByTestId('action-confirm').click();
    await expect(page.getByTestId('mapping-row')).toContainText(['Engineering']);
    await expect(page.getByTestId('mapping-row')).toContainText('posts on main');

    // The section shows up in Settings without a reload.
    await page.getByTestId('tab-bar').getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByTestId('company-link')).toContainText('Work accounts');
  });

  test('toasts never block the app; the review sheet closes on apply; undo stays in History', async ({
    page,
  }) => {
    await reset(page, true);
    await page.goto('/admin/settings/privacy');
    await page.locator('[data-setting-field="relays.0.public.portal"] [role="switch"]').click();
    await page.getByTestId('section-save').click();
    const review = page.getByTestId('config-diff-sheet');
    await review.getByTestId('config-apply').click();
    await expect(review).toBeHidden();
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();

    // The layer around the toast lets clicks through; the tab bar stays usable.
    const box = await toast.boundingBox();
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="toaster"]') !== null,
      { x: 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 },
    );
    expect(hit).toBe(false);
    await page.getByTestId('section-save').click({ trial: true });

    await toast.getByTestId('toast-close').click();
    await expect(toast).toHaveCount(0);
    await page.getByTestId('tab-bar').getByRole('link', { name: 'Settings' }).click();
    await page.getByTestId('history-link').click();
    await page.getByTestId('history-undo-button').click();
    await expect(page.getByTestId('history-undo')).toHaveCount(0);
    expect((await serverLog(page)).log.at(-1)?.id).toBe('undo');
  });
});

// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone: Settings → Updates & health (one-tap update + rollback, doctor, resource advice). */
import { expect, test } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

test.describe('updates & health', () => {
  test.beforeEach(async ({ page }) => {
    await signedIn(page);
    await reset(page, true);
  });

  test('reachable from Settings', async ({ page }) => {
    await page.goto('/admin/settings');
    await page.getByTestId('system-link').click();
    await expect(page).toHaveURL(/\/admin\/settings\/system$/);
    await expect(page.getByTestId('current-version')).toHaveText('You have version 0.1.0.');
  });

  test('one-tap update: preview → live progress → done → go back', async ({ page }) => {
    await page.goto('/admin/settings/system');
    const card = page.getByTestId('update-card');
    await expect(card.getByTestId('release-notes')).toContainText('Faster sign-in.');
    await card.getByTestId('update-now').click();

    const sheet = page.getByTestId('action-sheet');
    const diff = sheet.getByTestId('diff');
    await expect(diff).toContainText('Back up your data (≈120 MB)');
    await expect(diff).toContainText('Download version 0.2.0');
    await expect(diff).toContainText('Restart into 0.2.0 (about 5 seconds offline)');
    await sheet.getByTestId('action-confirm').click();

    const progress = card.getByTestId('update-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('Updating to 0.2.0');
    await expect(card.getByTestId('step-download')).toHaveAttribute('data-status', /active|done/, {
      timeout: 10_000,
    });
    // The restart takes the server away for a moment; the page waits for it.
    await expect(card.getByTestId('step-check')).toHaveAttribute('data-status', /active|done/, {
      timeout: 15_000,
    });
    await expect(page.getByTestId('toast').filter({ hasText: 'Updated to 0.2.0' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(progress).toBeHidden();
    await expect(card.getByTestId('current-version')).toHaveText('You have version 0.2.0.');
    const row = card.getByTestId('rollback-row');
    await expect(row).toContainText('Version 0.1.0 is kept');

    // Going back is offered until the next update; it shows what happens to the data.
    await row.getByTestId('rollback').click();
    await sheet.getByTestId('action-continue').click();
    await expect(sheet.getByTestId('diff')).toContainText('Go back to version 0.1.0');
    await expect(sheet.getByTestId('diff')).toContainText('Your data stays as it is now');
    await sheet.getByTestId('action-confirm').click();
    await expect(card.getByTestId('update-outcome')).toContainText('Went back to 0.1.0', {
      timeout: 15_000,
    });
    await expect(card.getByTestId('current-version')).toHaveText('You have version 0.1.0.');
    await expect(card.getByTestId('rollback-row')).toBeHidden();

    const log = (await serverLog(page)).log.map((l) => l.id);
    expect(log).toContain('system.update');
    expect(log).toContain('system.rollback');
  });

  test('doctor: problems first with plain text, fix via preview, lens per check', async ({
    page,
  }) => {
    await page.goto('/admin/settings/system#doctor');
    const doctor = page.getByTestId('doctor');
    await expect(doctor.getByTestId('doctor-summary')).toHaveText('1 problem(s), 1 warning(s).');
    const ws = doctor.getByTestId('check-proxy.websocket');
    await expect(ws).toHaveAttribute('data-tone', 'red');
    await expect(ws).toContainText('Your proxy does not pass WebSocket connections');
    await expect(ws).not.toContainText('self-check');
    await ws.getByTestId('item-lens').click();
    await expect(ws.getByTestId('item-lens-details')).toContainText('check proxy.websocket');
    // Green checks are folded away until asked for.
    await expect(doctor.getByTestId('check-clock.skew')).toBeHidden();
    await doctor.getByTestId('doctor-toggle').click();
    await expect(doctor.getByTestId('check-clock.skew')).toHaveAttribute('data-tone', 'green');

    const disk = doctor.getByTestId('check-disk.free');
    await disk.getByTestId('doctor-fix').click();
    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('Remove 1,204 old reactions');
    await sheet.getByTestId('action-confirm').click();
    await expect(doctor.getByTestId('check-disk.free')).toBeHidden();
    await expect(doctor.getByTestId('doctor-summary')).toHaveText('1 problem(s), 0 warning(s).');
  });

  test('advisor: size headline, apply a suggestion with preview + undo, dismiss with undo', async ({
    page,
  }) => {
    await page.goto('/admin/settings/system');
    const adv = page.getByTestId('advisor');
    await expect(adv.getByTestId('advisor-size')).toContainText(
      'Your relay would run comfortably on 1 vCPU / 1 GB',
    );
    const workers = adv.getByTestId('advice-verify-workers-off');
    await workers.getByTestId('advice-apply').click();
    const sheet = page.getByTestId('action-sheet');
    await expect(sheet.getByTestId('diff')).toContainText('Check signatures on the main thread');
    await sheet.getByTestId('action-confirm').click();
    await expect(adv.getByTestId('advice-verify-workers-off')).toBeHidden();
    await page.getByTestId('toast-undo').first().click();
    await expect(adv.getByTestId('advice-verify-workers-off')).toBeVisible();

    const disk = page.getByTestId('advice-disk-forecast');
    await disk.getByTestId('advice-dismiss').click();
    await expect(disk).toBeHidden();
    await page.getByTestId('toast-undo').first().click();
    await expect(page.getByTestId('advice-disk-forecast')).toBeVisible();
  });
});

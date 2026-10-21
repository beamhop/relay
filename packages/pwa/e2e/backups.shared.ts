// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings → Backups and restore (lifecycle module, vanilla lazy chunk) —
 * shared by the phone spec (backups.e2e.ts) and the desktop spec
 * (backups-desktop.e2e.ts). Mocks: e2e/mocks/backups.ts.
 */
import { type test as base, expect } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

export function backupsSpecs(test: typeof base) {
  test.describe('backups and restore', () => {
    test.beforeEach(async ({ page }) => {
      await signedIn(page);
      await reset(page, true);
    });

    test('Settings → Backups and restore → Back up now (3 taps)', async ({ page }) => {
      await page.goto('/admin/settings');
      await page.getByRole('link', { name: 'Backups and restore' }).click();
      await expect(page).toHaveURL(/\/admin\/m\/settings\/backups$/);
      const screen = page.getByTestId('backups-screen');
      await expect(screen).toBeVisible();
      await expect(page.getByTestId('module-missing')).toHaveCount(0);
      await expect(screen.getByTestId('backups-schedule')).toHaveText(
        'Backs up every day, keeps the newest 14',
      );
      await expect(screen.getByTestId('backup-row')).toHaveCount(2);

      await screen.getByTestId('backup-now').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'Backup made' })).toBeVisible();
      await expect(screen.getByTestId('backup-row')).toHaveCount(3);
      await expect(screen.getByTestId('backups-last')).toContainText('Last backup just now');
      expect((await serverLog(page)).log.map((l) => l.id)).toContain('backups.run-now');
    });

    test('check a backup; restore shows what changes before it happens', async ({ page }) => {
      await page.goto('/admin/m/settings/backups');
      const screen = page.getByTestId('backups-screen');
      const newest = screen.getByTestId('backup-row').first();
      await expect(newest.getByTestId('backup-check-state')).toHaveAttribute(
        'data-state',
        'unchecked',
      );
      await expect(
        screen.getByTestId('backup-row').nth(1).getByTestId('backup-check-state'),
      ).toHaveAttribute('data-state', 'ok');
      await newest.getByTestId('backup-check').click();
      await expect(
        page.getByTestId('toast').filter({ hasText: 'This backup is complete and undamaged' }),
      ).toBeVisible();
      await expect(newest.getByTestId('backup-check-state')).toHaveAttribute('data-state', 'ok');

      // Technical details only behind the lens.
      await expect(newest).not.toContainText('sqlite');
      await newest.getByTestId('item-lens').click();
      await expect(newest).toContainText('format sqlite');

      await newest.getByTestId('backup-restore').click();
      const sheet = page.getByTestId('action-sheet');
      await expect(sheet.getByTestId('diff')).toContainText('Changes made since then are lost');
      expect((await serverLog(page)).log.map((l) => l.id)).not.toContain('backups.restore');
      await sheet.getByTestId('action-confirm').click();
      await expect(page.getByTestId('toast').filter({ hasText: 'Backup restored' })).toBeVisible();
      expect((await serverLog(page)).log.map((l) => l.id)).toContain('backups.restore');

      // Archives found in storage can be restored too; settings are one tap away.
      await expect(screen.getByTestId('backups-found')).toContainText('Backup file · 30 MB');
      await screen.getByTestId('backups-settings-link').click();
      await expect(page).toHaveURL(/\/admin\/settings\/backups$/);
      await expect(page.getByTestId('simple-screen')).toBeVisible();
    });

    test('standby setup file and clean-up are offered', async ({ page }) => {
      await page.goto('/admin/m/settings/backups');
      const standby = page.getByTestId('backups-standby');
      await expect(standby.getByTestId('standby-status')).toContainText('Off.');
      await standby.getByTestId('standby-file').click();
      await expect(page.getByTestId('action-sheet')).toContainText('litestream.yml');
      await page.keyboard.press('Escape');
      await page.getByTestId('retention-run').click();
      await expect(page.getByTestId('action-sheet').getByTestId('diff')).toContainText(
        'nothing to remove',
      );
    });
  });
}

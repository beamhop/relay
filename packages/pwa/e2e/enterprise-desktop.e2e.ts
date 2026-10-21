// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop: enterprise screens (GAPS B1) — keyboard approvals, full group table, sidebar links. */
import { type Page, expect, test } from '@playwright/test';
import { serverLog, signedIn } from './helpers.ts';

async function enterprise(page: Page) {
  await page.request.post('/__reset', { data: { claimed: true, ai: 'absent', enterprise: true } });
  await signedIn(page);
}

test('approvals inbox: x denies the top card from the keyboard', async ({ page }) => {
  await enterprise(page);
  await page.goto('/admin/m/approvals');
  await expect(page.getByTestId('approval-card')).toContainText('Bob Baker');
  await page.keyboard.press('x');
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  await expect(page.getByTestId('decided')).toContainText('Denied by Owner');
  expect((await serverLog(page)).log.map((l) => l.id)).toContain('approvals.deny');
});

test('approvals inbox: e approves; own requests are listed apart and can be withdrawn', async ({
  page,
}) => {
  await enterprise(page);
  // File an own request first (disconnect is gated by the two-person rule).
  await page.goto('/admin/m/people/company');
  await page.getByTestId('disconnect-idp').click();
  await page.getByTestId('action-confirm').click();
  await expect(page.getByTestId('waiting-approval')).toBeVisible();

  await page.goto('/admin/m/approvals');
  await expect(page.getByTestId('approval-card')).toContainText('Bob Baker');
  await expect(page.getByTestId('my-requests')).toContainText(
    'Disconnect a company sign-in provider',
  );
  await page.keyboard.press('e');
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  await page.getByTestId('my-requests').getByTestId('withdraw').click();
  await expect(page.getByTestId('my-requests')).toHaveCount(0);
  await expect(page.getByTestId('decided')).toContainText('Withdrawn');
});

test('company groups: the full table on desktop', async ({ page }) => {
  await enterprise(page);
  await page.goto('/admin/people');
  await page.getByRole('link', { name: 'Company groups' }).click();
  const row = page.getByTestId('rule-row');
  await expect(row).toContainText('eng');
  await expect(row).toContainText('Moderator');
  await expect(row).toContainText('Company keeps keys');
});

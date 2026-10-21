// SPDX-License-Identifier: AGPL-3.0-or-later
/** Phone: enterprise screens (GAPS B1) — company groups, company keys, compliance, approvals, network access. */
import { type Page, expect, test } from '@playwright/test';
import { serverLog, signedIn, touchSwipe } from './helpers.ts';

async function enterprise(page: Page, on = true) {
  await page.request.post('/__reset', { data: { claimed: true, ai: 'absent', enterprise: on } });
  await signedIn(page);
}

test('without enterprise there are no company screens and no enterprise chunk is loaded', async ({
  page,
}) => {
  await enterprise(page, false);
  const chunks: string[] = [];
  page.on('response', async (r) => {
    if (r.url().endsWith('.js')) chunks.push(await r.text().catch(() => ''));
  });
  await page.goto('/admin/settings');
  await expect(page.locator('h1')).toHaveText('Settings');
  await expect(page.getByRole('link', { name: 'Compliance' })).toHaveCount(0);
  await page.goto('/admin/people');
  await expect(page.getByRole('link', { name: 'Company groups' })).toHaveCount(0);
  await page.goto('/admin/m/approvals');
  await expect(page.getByTestId('module-missing')).toBeVisible();
  expect(chunks.some((t) => t.includes('Waiting for a second admin'))).toBe(false);
});

test('company groups: rules with undo, people, offboarding, sync, disconnect needs a second admin', async ({
  page,
}) => {
  await enterprise(page);
  await page.goto('/admin/people');
  await page.getByRole('link', { name: 'Company groups' }).click();
  await expect(page).toHaveURL(/\/admin\/m\/people\/company$/);
  const rules = page.getByTestId('group-rules');
  await expect(rules.getByTestId('rule-row')).toHaveCount(1);
  await expect(rules.getByTestId('rule-row')).toContainText('Posts on main');

  // Remove a rule: plain preview → confirm → undo toast brings it back.
  await rules.getByTestId('remove-rule').click();
  await expect(page.getByTestId('diff')).toContainText('no longer gets access');
  await page.getByTestId('action-confirm').click();
  await expect(rules.getByTestId('rule-row')).toHaveCount(0);
  await page.getByTestId('toast-undo').click();
  await expect(rules.getByTestId('rule-row')).toHaveCount(1);

  // People by name, offboarding with a preview.
  const people = page.getByTestId('company-people');
  await expect(people.getByTestId('person-row')).toHaveCount(3);
  await expect(people).toContainText('Alice Archer');
  await expect(people).not.toContainText('c'.repeat(64));
  const carol = people.locator('[data-person="carol@acme.com"]');
  await expect(carol).toContainText('Not linked yet');
  await carol.getByTestId('offboard').click();
  await expect(page.getByTestId('diff')).toContainText('loses access right away');
  await page.getByTestId('action-confirm').click();
  await expect(carol).toContainText('Access removed');

  // Directory sync.
  await expect(page.getByTestId('directory-sync')).toContainText('Directory synced');
  await page.getByTestId('sync-now').click();
  await page.getByTestId('action-confirm').click();
  await expect(page.getByTestId('toast').first()).toContainText('synced');

  // Disconnect: the two-person rule turns it into a request.
  const provider = page.getByTestId('provider-row');
  await expect(provider).toContainText('Google Workspace');
  await provider.getByTestId('disconnect-idp').click();
  await expect(page.getByTestId('diff')).toContainText('Another admin must approve');
  await page.getByTestId('action-confirm').click();
  await expect(provider.getByTestId('waiting-approval')).toContainText(
    'Waiting for a second admin',
  );
  await expect(provider.getByTestId('disconnect-idp')).toHaveCount(0);
  const log = await serverLog(page);
  expect(log.log.map((l) => l.id)).toEqual(
    expect.arrayContaining([
      'enterprise.unmap-group',
      'enterprise.offboard-person',
      'enterprise.disconnect-idp',
    ]),
  );
});

test('approvals: who asked, what happens, swipe right approves; own requests cannot be approved', async ({
  page,
}) => {
  await enterprise(page);
  await page.goto('/admin/activity');
  await page.getByRole('link', { name: 'Approvals' }).click();
  await expect(page).toHaveURL(/\/admin\/m\/approvals$/);
  const card = page.getByTestId('approval-card');
  await expect(card.getByTestId('approval-requester')).toContainText('Bob Baker asked');
  await expect(card.getByTestId('approval-requester')).toContainText('Left the team');
  await expect(card.getByTestId('approval-diff')).toContainText('loses access right away');
  await touchSwipe(page, card, 260, 0);
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  await expect(page.getByTestId('decided')).toContainText('Approved by Owner');
  expect((await serverLog(page)).log.map((l) => l.id)).toContain('approvals.approve');
});

test('approvals: a notification link opens that request', async ({ page }) => {
  await enterprise(page);
  await page.goto('/admin/m/approvals/apr_other');
  await expect(
    page.getByTestId('approval-card').locator('[data-request="apr_other"]'),
  ).toBeVisible();
});

test('company keys: status in plain words, rotation waits for a second admin, delayed destroy and keep', async ({
  page,
}) => {
  await enterprise(page);
  await page.goto('/admin/settings');
  await page.getByRole('link', { name: 'Company keys' }).click();
  await expect(page).toHaveURL(/\/admin\/m\/settings\/company\/keys$/);
  await expect(page.getByTestId('vault-status')).toContainText('AWS Key Management Service');
  await expect(page.getByTestId('signing-history')).toContainText('Alice Archer');
  await expect(page.getByTestId('signing-history')).toContainText('Signed a post');

  await page.getByTestId('rotate-kek').click();
  await page.getByTestId('action-confirm').click();
  await expect(page.getByTestId('vault-status').getByTestId('waiting-approval')).toContainText(
    'Waiting for a second admin',
  );

  const row = page.locator('[data-testid="key-row"][data-subject="google:alice"]');
  await expect(row).toContainText('Alice Archer');
  await row.getByTestId('destroy-key').click();
  await page.locator('[data-setting-field="reason"] input').fill('Left the company');
  await page.getByTestId('action-continue').click();
  await expect(page.getByTestId('diff')).toContainText('You can cancel until then');
  await page.getByTestId('action-confirm').click();
  await expect(row).toHaveAttribute('data-status', 'pending-destroy');
  await expect(row).toContainText('Will be destroyed on');
  await row.getByTestId('keep-key').click();
  await expect(row).toHaveAttribute('data-status', 'active');
});

test('compliance: holds, release asks a second admin, archive download, log test, data location', async ({
  page,
}) => {
  await enterprise(page);
  await page.goto('/admin/settings');
  await page.getByRole('link', { name: 'Compliance' }).click();
  await expect(page).toHaveURL(/\/admin\/m\/settings\/compliance$/);
  const hold = page.getByTestId('hold-row');
  await expect(hold).toContainText('Acme v. Example');
  await hold.getByTestId('release-hold').click();
  await page.locator('[data-setting-field="reason"] input').fill('Case closed');
  await page.getByTestId('action-continue').click();
  await page.getByTestId('action-confirm').click();
  await expect(hold.getByTestId('waiting-approval')).toContainText('Waiting for a second admin');

  const download = page.waitForEvent('download');
  await page.getByTestId('export-file').click();
  expect((await download).suggestedFilename()).toContain('manifest.json');

  await expect(page.getByTestId('siem')).toContainText('Splunk');
  await page.getByTestId('test-sink').click();
  await page.getByTestId('action-confirm').click();
  await expect(page.getByTestId('toast').first()).toContainText('received the test record');
  await expect(page.getByTestId('residency-ok')).toBeVisible();

  await page.getByTestId('compliance-advanced').click();
  await page.getByTestId('make-report').click();
  await expect(page.getByTestId('usage-report')).toContainText('eng');
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('report-csv').click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^usage-report-\d{4}-\d{2}\.csv$/);
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('report-pdf').click(),
  ]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
});

test('network access: ≤7 settings, saved through the standard settings review', async ({
  page,
}) => {
  await enterprise(page);
  await page.goto('/admin/settings');
  await page.getByRole('link', { name: 'Network access' }).click();
  await expect(page).toHaveURL(/\/admin\/m\/settings\/network$/);
  const simple = page.getByTestId('network-simple');
  await expect(simple.locator('[data-setting-field]')).toHaveCount(7);
  await expect(simple).toContainText('Networks that can use Test Relay');
  await expect(simple).toContainText('Blocked networks');
  await simple
    .locator('[data-setting-field="modules.enterprise-network.allowlist.admin"] input')
    .fill('10.0.0.0/8');
  await simple
    .locator('[data-setting-field="modules.enterprise-network.allowlist.admin"] input')
    .blur();
  await page.getByTestId('network-save').click();
  const review = page.getByTestId('config-diff-sheet');
  await review.getByTestId('config-apply').click();
  await expect(review).toBeHidden();
  await expect(page.getByTestId('proxy-warning')).toBeVisible();
  const log = await serverLog(page);
  expect(log.log.map((l) => l.id)).toContain('config.commit');
});

test('network access: team groups stay on company relays (Advanced)', async ({ page }) => {
  await enterprise(page);
  await page.goto('/admin/m/settings/network');
  await page.getByTestId('network-advanced-open').click();
  const groups = page.getByTestId('network-outbound');
  await expect(groups).toContainText('Messages in these groups stay on your company’s relays');
  await expect(groups).toContainText('Other relays “Engineering” may also post to');
  await expect(page.getByText('Networks blocked from Test Relay')).toBeVisible();
  // The "every group" list only shows once the switch is on.
  const every = '[data-setting-field="modules.enterprise-network.outbound.default"]';
  await expect(groups.locator(every)).toHaveCount(0);
  await groups
    .locator('[data-setting-field="modules.enterprise-network.outbound.limit"] [role="switch"]')
    .click();
  await expect(groups.locator(every)).toBeVisible();
  const eng = groups.locator(
    '[data-setting-field="modules.enterprise-network.outbound.groups.eng-chat"] input',
  );
  await eng.fill('wss://partner.example.com');
  await eng.blur();
  await page.getByRole('button', { name: 'Save' }).last().click();
  const review = page.getByTestId('config-diff-sheet');
  await expect(review).toBeVisible();
  await review.getByTestId('config-apply').click();
  await expect(review).toBeHidden();
  const log = await serverLog(page);
  const commit = log.log.filter((l) => l.id === 'config.commit').pop();
  expect(JSON.stringify(commit)).toContain('partner.example.com');
});

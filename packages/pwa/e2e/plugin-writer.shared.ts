// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Write a plugin from a description" (§6.5.4) — shared by the phone spec
 * (plugin-writer.e2e.ts) and the desktop spec (plugin-writer-desktop.e2e.ts).
 * `ai.generate-plugin` is mocked in e2e/mocks/plugins.ts.
 */
import { type Page, type test as base, expect } from '@playwright/test';
import { reset, serverLog, signedIn } from './helpers.ts';

const DESC = 'Refuse posts with more than 5 links from people who joined this week';
const ID = 'ai-refuse-posts-with-more-than-5-links-from';

/** Hold `ai.generate-plugin` requests for a while so the progress state is visible. */
async function slowGenerate(page: Page, ms: number) {
  await page.route('**/actions/ai.generate-plugin', async (route) => {
    await new Promise((r) => setTimeout(r, ms));
    await route.continue();
  });
}

async function openWriter(page: Page) {
  await page.goto('/admin/settings/plugins');
  await page.getByTestId('plugin-write').click();
  const sheet = page.getByTestId('plugin-writer');
  await expect(sheet).toBeVisible();
  return sheet;
}

export function pluginWriterSpecs(test: typeof base) {
  test.describe('write a plugin', () => {
    test.beforeEach(async ({ page }) => {
      await signedIn(page);
    });

    test('is not offered without the assistant', async ({ page }) => {
      await reset(page, true, { ai: 'absent' });
      await page.goto('/admin/settings/plugins');
      await expect(
        page.getByTestId('plugin-installed').or(page.getByTestId('plugins-none')),
      ).toBeVisible();
      await expect(page.getByTestId('plugin-write')).toHaveCount(0);
    });

    test('describe → generate → review (installed off) → turn on with preview and undo', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await reset(page, true, { ai: 'on' });
      await slowGenerate(page, 700);
      const sheet = await openWriter(page);

      const generate = page.getByTestId('plugin-writer-generate');
      await expect(generate).toBeDisabled();
      await sheet.getByTestId('plugin-writer-example').first().click();
      await expect(sheet.getByTestId('plugin-writer-description')).toHaveValue(DESC);
      await generate.click();

      await expect(sheet.getByTestId('plugin-writer-generating')).toBeVisible();
      await expect(page.getByTestId('plugin-writer-cancel')).toBeVisible();

      await expect(sheet.getByTestId('plugin-writer-installed')).toHaveText(
        'Installed, turned off. Review it, then turn it on.',
      );
      await expect(sheet.getByTestId('plugin-writer-name')).toHaveText(
        'Limit links from newcomers',
      );
      await expect(sheet.getByTestId('plugin-writer-test-counts')).toHaveText(
        'All 3 checks passed.',
      );
      await expect(sheet.getByTestId('plugin-writer-test')).toHaveCount(3);
      await expect(sheet.getByTestId('plugin-writer-perms')).toContainText(
        'Read posts and profiles stored on this relay',
      );
      // Code only behind the technical lens.
      const code = sheet.getByTestId('plugin-writer-code');
      await expect(code.getByTestId('plugin-writer-source')).toHaveCount(0);
      await code.getByTestId('item-lens').click();
      await expect(code.getByTestId('plugin-writer-source').first()).toContainText('definePlugin');
      await code.getByTestId('plugin-writer-copy').first().click();
      await expect(page.getByTestId('toast').filter({ hasText: 'Copied' })).toBeVisible();

      // Installed, but never turned on by itself.
      expect((await serverLog(page)).plugins[ID]).toMatchObject({ enabled: false });

      await page.getByTestId('plugin-writer-enable').click();
      const flow = page.getByTestId('action-sheet');
      await expect(flow.getByTestId('diff')).toContainText('will start checking new activity');
      expect((await serverLog(page)).plugins[ID]?.enabled).toBe(false);
      await flow.getByTestId('action-confirm').click();
      await expect(sheet.getByTestId('plugin-writer-enabled')).toBeVisible();
      await expect.poll(async () => (await serverLog(page)).plugins[ID]?.enabled).toBe(true);

      await page.getByTestId('toast-undo').first().click();
      await expect.poll(async () => (await serverLog(page)).plugins[ID]?.enabled).toBe(false);
      await expect(page.getByTestId('plugin-writer-enable')).toBeVisible();

      await sheet.getByRole('button', { name: 'Close' }).click();
      const row = page.locator(`[data-testid="plugin-installed"][data-plugin="${ID}"]`);
      await expect(row).toHaveAttribute('data-enabled', 'false');
      await expect(row.getByTestId('plugin-ai-badge')).toHaveText('Written by the assistant');
    });

    test('cancel keeps the description and takes the late draft away', async ({ page }) => {
      await reset(page, true, { ai: 'on' });
      await slowGenerate(page, 1200);
      const sheet = await openWriter(page);
      await sheet.getByTestId('plugin-writer-description').fill(DESC);
      await page.getByTestId('plugin-writer-generate').click();
      await expect(sheet.getByTestId('plugin-writer-generating')).toBeVisible();
      await page.getByTestId('plugin-writer-cancel').click();
      await expect(sheet.getByTestId('plugin-writer-description')).toHaveValue(DESC);
      await expect
        .poll(async () => (await serverLog(page)).log.some((l) => l.id === 'undo'), {
          timeout: 5000,
        })
        .toBe(true);
      expect((await serverLog(page)).plugins[ID]).toBeUndefined();
      await expect(sheet.getByTestId('plugin-writer-installed')).toHaveCount(0);
    });

    test('failed tests: cannot turn on, Why? explains, try again is pre-filled', async ({
      page,
    }) => {
      await reset(page, true, { ai: 'on' });
      const sheet = await openWriter(page);
      const text = 'Block posts that fail the spam check';
      await sheet.getByTestId('plugin-writer-description').fill(text);
      await page.getByTestId('plugin-writer-generate').click();

      await expect(sheet.getByTestId('plugin-writer-test-counts')).toHaveText(
        '1 failed, 2 passed.',
      );
      const failed = sheet.locator('[data-testid="plugin-writer-test"][data-ok="false"]');
      await expect(failed).toHaveText(/lets a normal post through/);
      await failed.locator('summary').click();
      await expect(failed).toContainText('Received: "reject"');

      await expect(page.getByTestId('plugin-writer-enable')).toBeDisabled();
      await expect(page.getByTestId('plugin-writer-block')).toContainText(
        'some of its checks failed',
      );
      await page.getByTestId('plugin-writer-why').click();
      const why = page.getByTestId('plugin-writer-why-sheet');
      await expect(why).toContainText('lets a normal post through');
      await why.getByRole('button', { name: 'Close' }).click();

      await page.getByTestId('plugin-writer-retry').click();
      await expect(sheet.getByTestId('plugin-writer-description')).toHaveValue(text);
      expect(Object.keys((await serverLog(page)).plugins)).toEqual([]);
    });

    test('unusable answer shows a plain failure', async ({ page }) => {
      await reset(page, true, { ai: 'on' });
      const sheet = await openWriter(page);
      await sheet.getByTestId('plugin-writer-description').fill('Something broken and vague');
      await page.getByTestId('plugin-writer-generate').click();
      await expect(sheet.getByTestId('plugin-writer-failed')).toContainText('could not be written');
      await expect(page.getByTestId('plugin-writer-generate')).toHaveText(/Try again/);
    });

    test('discard hides the draft with undo, then removes it', async ({ page }) => {
      await reset(page, true, { ai: 'on' });
      const sheet = await openWriter(page);
      await sheet.getByTestId('plugin-writer-description').fill(DESC);
      await page.getByTestId('plugin-writer-generate').click();
      await expect(sheet.getByTestId('plugin-writer-installed')).toBeVisible();

      const row = page.locator(`[data-testid="plugin-installed"][data-plugin="${ID}"]`);
      await page.getByTestId('plugin-writer-discard').click();
      await expect(sheet).toHaveCount(0);
      await expect(row).toHaveCount(0);
      await page.getByTestId('toast-undo').first().click();
      await expect(row).toBeVisible();
      expect((await serverLog(page)).plugins[ID]).toBeDefined();

      // Discarded again: leaving the screen removes it right away.
      await page.getByTestId('plugin-write').click();
      await sheet.getByTestId('plugin-writer-description').fill(DESC);
      await page.getByTestId('plugin-writer-generate').click();
      await expect(sheet.getByTestId('plugin-writer-installed')).toBeVisible();
      await page.getByTestId('plugin-writer-discard').click();
      await expect(row).toHaveCount(0);
      expect((await serverLog(page)).plugins[ID]).toBeDefined();
      await page.locator('main a[href$="/settings"]').first().click();
      await expect(page).toHaveURL(/\/admin\/settings\/?$/);
      await expect.poll(async () => (await serverLog(page)).plugins[ID]).toBeUndefined();
    });
  });
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Vanilla profile wizard snapshot (PLAN §12.0.6): with no enterprise module the first-run
 * wizard keeps its steps, and no step mentions company/enterprise features (the
 * "Company / Organization" persona card is the single allowed entry point, §12.0.1).
 *
 * The outline (step ids, headings, progress length, persona choices) is compared with
 * `vanilla.wizard.txt` next to this file. After an intended wizard change, refresh it:
 *
 *   UPDATE_VANILLA_SNAPSHOT=1 bunx playwright test e2e/vanilla.e2e.ts --project iphone
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, expect, test } from '@playwright/test';
import { findEnterpriseTerms, unallowed } from '../../../scripts/ci/enterprise-terms.ts';
import { fakeExtension, reset } from './helpers.ts';

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'vanilla.wizard.txt');

async function capture(page: Page, step: string, lines: string[]): Promise<void> {
  const wizard = page.getByTestId('onboarding');
  await expect(wizard).toHaveAttribute('data-step', step);
  const heading = (await wizard.getByRole('heading', { level: 1 }).innerText()).trim();
  // The step indicator is the first list (the recovery step has a list of codes too).
  const progress = await wizard.locator('ol').first().locator('li').count();
  lines.push(`step ${step}: "${heading}" (progress ${progress})`);
  // Everything visible on the step, plus accessible names (aria-labels, alt text).
  const text = [
    await wizard.innerText(),
    ...(await wizard
      .locator('[aria-label],[title],img[alt]')
      .evaluateAll((els) =>
        els.map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`),
      )),
  ].join('\n');
  const hits = unallowed(findEnterpriseTerms(text));
  expect(hits.map((h) => `${step}: ${h.context}`)).toEqual([]);
}

test.describe('vanilla profile', () => {
  test('first-run wizard: same steps, nothing enterprise', async ({ page }) => {
    await reset(page, false);
    await fakeExtension(page);
    await page.goto('/admin/');
    const lines: string[] = [];

    await capture(page, 'claim', lines);
    await page.getByTestId('claim-code').fill('TEST-CODE-1234');
    await page.getByTestId('signin-extension').click();

    await capture(page, 'persona', lines);
    const personas = await page
      .getByRole('radio')
      .evaluateAll((els) =>
        els.map(
          (e) =>
            `${e.getAttribute('data-testid')}: ${e.querySelector('.font-medium')?.textContent?.trim()}`,
        ),
      );
    for (const p of personas) lines.push(`  ${p}`);
    await page.getByTestId('persona-public-social').click();

    await capture(page, 'domain', lines);
    await page.getByRole('button', { name: 'Skip' }).click();

    await capture(page, 'done', lines);
    await page.getByTestId('done-next').click();

    await capture(page, 'recovery', lines);
    await page.getByTestId('recovery-saved').check();
    await page.getByTestId('wizard-finish').click();
    await expect(page.getByTestId('tab-bar')).toBeVisible();

    const actual = `${lines.join('\n')}\n`;
    if (process.env.UPDATE_VANILLA_SNAPSHOT === '1') writeFileSync(SNAPSHOT, actual);
    expect(actual).toBe(readFileSync(SNAPSHOT, 'utf8'));
  });
});

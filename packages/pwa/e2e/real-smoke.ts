// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Smoke test against a REAL Beamhop server (not part of the mocked E2E suite):
 *
 *   bun packages/runtime-bun/src/main.ts --listen 127.0.0.1:3410 --data-dir /tmp/smoke
 *   bun packages/pwa/e2e/real-smoke.ts http://127.0.0.1:3410 <claim-code>
 *
 * Without a claim code it only checks that the claim screen renders. With one,
 * it claims the server through the UI using a real NIP-07 signer (a fresh key
 * held by the test, signing with nostr-tools), walks the wizard and checks Home.
 */
import { chromium, devices } from '@playwright/test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const base = process.argv[2] ?? 'http://127.0.0.1:3410';
const claimCode = process.argv[3];
const sk = generateSecretKey();

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.exposeFunction('__sign', (t: Parameters<typeof finalizeEvent>[0]) =>
  finalizeEvent(t, sk),
);
await page.addInitScript((pk: string) => {
  const w = window as unknown as { nostr: unknown; __sign: (t: unknown) => Promise<unknown> };
  w.nostr = { getPublicKey: async () => pk, signEvent: (t: unknown) => w.__sign(t) };
}, getPublicKey(sk));

await page.goto(`${base}/admin/`);
await page.getByTestId('onboarding').waitFor();
console.log('claim screen:', await page.getByTestId('onboarding').getAttribute('data-step'));

if (claimCode) {
  await page.getByTestId('claim-code').fill(claimCode);
  await page.getByTestId('signin-extension').click();
  await page.locator('[data-step="persona"]').waitFor();
  console.log('claimed; persona step');
  await page.getByTestId('persona-public-social').click();
  await page.locator('[data-step="domain"]').waitFor();
  console.log('tls:', (await page.getByTestId('tls-status').innerText()).replace(/\s+/g, ' '));
  await page.getByRole('button', { name: 'Skip' }).click();
  await page.locator('[data-step="done"]').waitFor();
  console.log('relay url:', await page.getByTestId('relay-url').innerText());
  await page.getByTestId('done-next').click();
  console.log(
    'recovery codes:',
    (await page.getByTestId('recovery-codes').innerText()).split('\n').length,
  );
  await page.getByTestId('recovery-saved').check();
  await page.getByTestId('wizard-finish').click();
  await page.getByTestId('health-score').waitFor();
  console.log('health score:', await page.getByTestId('health-score').innerText());
  await page.getByTestId('attention').waitFor();
  if (process.env.SHOTS)
    await page.screenshot({ path: `${process.env.SHOTS}/home.png`, fullPage: true });
  for (const path of [
    '/activity?tab=queue',
    '/people',
    '/media',
    '/settings/access',
    '/settings/goals',
    '/settings/history',
    '/settings/plugins',
    '/settings/security',
    '/settings/company',
    '/settings/system',
    '/settings/backups',
    '/insights',
    '/launch',
    '/activity?tab=alerts',
    '/activity?tab=logs',
    '/activity/on-call',
  ]) {
    await page.goto(`${base}/admin${path}`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);
    const panel =
      (await page.getByTestId('error-panel').count()) +
      (await page.getByTestId('module-missing').count());
    if (process.env.SHOTS)
      await page.screenshot({ path: `${process.env.SHOTS}/${path.replace(/[^a-z]+/g, '-')}.png` });
    console.log(`${path}: ${panel ? 'ERROR PANEL' : 'ok'}`);
  }
}

console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
process.exit(errors.length ? 1 : 0);

// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Locator, Page } from '@playwright/test';

export interface ResetOptions {
  /** The assistant module is absent (default), installed but off, or on. */
  ai?: 'absent' | 'off' | 'on';
  /** A plugin the safety switch turned off. */
  tripped?: boolean;
  /** Home shows one informational card that cannot be approved. */
  infoCard?: boolean;
  /** Public host name of the relay. */
  host?: string;
  persona?: string;
}

/** Reset the mock API. */
export async function reset(page: Page, claimed: boolean, opts: ResetOptions = {}): Promise<void> {
  await page.request.post('/__reset', { data: { claimed, ...opts, ai: opts.ai ?? 'absent' } });
}

export async function serverLog(page: Page): Promise<{
  log: Array<{ id: string; input: unknown }>;
  bans: string[];
  relay: { goals: Record<string, number>; persona: string };
  channels: Array<{ type: string; id: string; [k: string]: unknown }>;
  tests: string[];
  assistant: Array<{ message: string; context?: Record<string, unknown> }>;
  plugins: Record<string, { enabled: boolean; config: Record<string, unknown>; tripped?: unknown }>;
  modules: Record<string, boolean>;
  idp: { provider: string; clientId?: string } | null;
  mappings: Array<Record<string, unknown>>;
}> {
  return (await page.request.get('/__log')).json();
}

/** A fake NIP-07 extension (the mock server does not verify signatures). */
export async function fakeExtension(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { nostr: unknown }).nostr = {
      getPublicKey: async () => 'a'.repeat(64),
      signEvent: async (t: Record<string, unknown>) => ({
        ...t,
        id: '0'.repeat(64),
        pubkey: 'a'.repeat(64),
        sig: '0'.repeat(128),
      }),
    };
  });
}

/** Start signed in: a stored session token and no onboarding in progress. */
export async function signedIn(page: Page): Promise<void> {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'beamhop.session',
      JSON.stringify({ token: 'session-token', expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    );
  });
}

/** Real touch swipe (Chromium CDP touch events → pointer events with pointerType "touch"). */
export async function touchSwipe(
  page: Page,
  target: Locator,
  dx: number,
  dy: number,
  steps = 14,
): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('swipe target not visible');
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 80);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-wrap keys other modules stored before the key vault was enabled.
 *
 * Touches exactly:
 * - `alerts.keys` / `nostr`  — `{ sk }` → `{ wrapped, provider: 'keyvault' }`
 *   (the alerts module already reads this shape through `ports.keyWrapper`).
 * - `relay.groups.key` / `<relayId>` — `{ secretKey, pubkey, createdAt }` →
 *   `{ pubkey, createdAt, wrapped, provider: 'keyvault' }` (on by default,
 *   `migrate.relayGroupKeys`; the relay unwraps it through `ports.keyWrapper`).
 * A record wrapped by a different, earlier wrapper is re-wrapped too when that
 * wrapper is still available (`fallback`).
 */
import type { DocStore, KeyWrapper } from '@beamhop/core';
import { fromB64, fromHex, toB64, zeroize } from './bytes.ts';

export const ALERTS_KEYS_COLLECTION = 'alerts.keys';
export const ALERTS_NOSTR_KEY = 'nostr';
export const RELAY_GROUP_KEYS_COLLECTION = 'relay.groups.key';

export interface MigrationReport {
  wrapped: Array<{ collection: string; key: string }>;
  alreadyWrapped: number;
  failed: Array<{ collection: string; key: string; error: string }>;
}

interface AlertsKey {
  sk?: string;
  wrapped?: string;
  provider?: string;
}

interface GroupKey {
  secretKey?: string;
  pubkey: string;
  createdAt: number;
  wrapped?: string;
  provider?: string;
}

async function rewrap<T extends object>(
  docs: DocStore,
  collection: string,
  key: string,
  cur: T,
  secretHex: string | undefined,
  wrappedB64: string | undefined,
  provider: string | undefined,
  port: KeyWrapper,
  fallback: KeyWrapper | undefined,
  build: (wrapped: string) => object,
  report: MigrationReport,
): Promise<void> {
  if (!secretHex && (!wrappedB64 || provider === port.provider)) {
    if (wrappedB64) report.alreadyWrapped++;
    return;
  }
  let raw: Uint8Array | undefined;
  try {
    if (secretHex) raw = fromHex(secretHex);
    else if (fallback && wrappedB64) raw = await fallback.unwrap(fromB64(wrappedB64));
    else {
      report.alreadyWrapped++;
      return;
    }
    const next = build(toB64(await port.wrap(raw)));
    if (!(await docs.cas(collection, key, cur, next))) throw new Error('changed concurrently');
    report.wrapped.push({ collection, key });
  } catch (err) {
    report.failed.push({ collection, key, error: String((err as Error).message ?? err) });
  } finally {
    zeroize(raw);
  }
}

export async function wrapLegacyKeys(
  docs: DocStore,
  port: KeyWrapper,
  opts: { alertsKey: boolean; relayGroupKeys: boolean },
  fallback?: KeyWrapper,
): Promise<MigrationReport> {
  const report: MigrationReport = { wrapped: [], alreadyWrapped: 0, failed: [] };
  if (opts.alertsKey) {
    const cur = await docs.get<AlertsKey>(ALERTS_KEYS_COLLECTION, ALERTS_NOSTR_KEY);
    if (cur)
      await rewrap(
        docs,
        ALERTS_KEYS_COLLECTION,
        ALERTS_NOSTR_KEY,
        cur,
        cur.sk,
        cur.wrapped,
        cur.provider,
        port,
        fallback,
        (wrapped) => ({ wrapped, provider: port.provider }),
        report,
      );
  }
  if (opts.relayGroupKeys) {
    let cursor: string | undefined;
    do {
      const page = await docs.list<GroupKey>(RELAY_GROUP_KEYS_COLLECTION, {
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      for (const { key, value } of page.items)
        await rewrap(
          docs,
          RELAY_GROUP_KEYS_COLLECTION,
          key,
          value,
          value.secretKey,
          value.wrapped,
          value.provider,
          port,
          fallback,
          (wrapped) => ({
            pubkey: value.pubkey,
            createdAt: value.createdAt,
            wrapped,
            provider: port.provider,
          }),
          report,
        );
      cursor = page.cursor;
    } while (cursor);
  }
  return report;
}

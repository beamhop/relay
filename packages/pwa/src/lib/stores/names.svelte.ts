// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * People names for public keys (§6.6: no unnamed hex in the simple view).
 * Names come from what the admin API already returns (team list, signed-in
 * admin, any list row carrying `name`/`displayName`); everyone else is shown
 * as a short `npub1abcd…wxyz`. The full key stays behind the technical lens.
 */
import { HEX64, npubShort, shortHex } from '../npub.ts';

/** Rows that may carry a pubkey and a display name. */
export type NameRow = {
  pubkey?: unknown;
  name?: unknown;
  displayName?: unknown;
  display_name?: unknown;
};

/** Returns rows with names; called once per relay. */
export type NameLoader = (relayId: string | null) => Promise<NameRow[]>;

const HEX_IN_TEXT = /\b[0-9a-f]{64}\b/gi;
const NPUB_IN_TEXT = /\bnpub1[02-9ac-hj-np-z]{58}\b/g;

export class Names {
  /** Lower-case hex pubkey → display name. Reactive. */
  known = $state<Record<string, string>>({});
  private loaded = new Map<string, Promise<void>>();

  constructor(private readonly loader: NameLoader = defaultLoader) {}

  remember(pubkey: unknown, name: unknown): void {
    if (typeof pubkey !== 'string' || !HEX64.test(pubkey)) return;
    if (typeof name !== 'string') return;
    const n = name.trim();
    if (!n || HEX64.test(n) || n.startsWith('npub1') || n === pubkey) return;
    const k = pubkey.toLowerCase();
    if (this.known[k] !== n) this.known[k] = n;
  }

  rememberRows(rows: readonly unknown[] | undefined | null): void {
    for (const r of rows ?? []) {
      if (!r || typeof r !== 'object') continue;
      const row = r as NameRow;
      this.remember(row.pubkey, row.displayName ?? row.display_name ?? row.name);
    }
  }

  /** Known name for a pubkey, or undefined. */
  nameOf(pubkey: string | null | undefined): string | undefined {
    return pubkey ? this.known[pubkey.toLowerCase()] : undefined;
  }

  /** Plain label for a person: their name, else `npub1abcd…wxyz`. */
  label(pubkey: string | null | undefined): string {
    if (!pubkey) return '';
    const n = this.nameOf(pubkey);
    if (n) return n;
    if (HEX64.test(pubkey) || pubkey.startsWith('npub1')) return npubShort(pubkey);
    return pubkey;
  }

  /**
   * Free text from the server (alerts, team feed, cards): long hex values become
   * a known person's name or a short form; full `npub1…` strings are shortened.
   */
  text(s: string | null | undefined): string {
    if (!s) return '';
    return s
      .replace(HEX_IN_TEXT, (h) => this.nameOf(h) ?? shortHex(h))
      .replace(NPUB_IN_TEXT, (n) => npubShort(n));
  }

  /** Load names once per relay (deduplicated). */
  ensure(relayId: string | null = null): Promise<void> {
    const key = relayId ?? '';
    let p = this.loaded.get(key);
    if (!p) {
      p = this.loader(relayId)
        .then((rows) => this.rememberRows(rows))
        .catch(() => {
          // names are a nicety: fall back to short keys
        });
      this.loaded.set(key, p);
    }
    return p;
  }

  /** Forget load state (e.g. after signing in again). */
  reset(): void {
    this.loaded.clear();
  }
}

async function defaultLoader(): Promise<NameRow[]> {
  const [{ app }, { query }] = await Promise.all([
    import('./app.svelte.ts'),
    import('./actions.svelte.ts'),
  ]);
  const rows: NameRow[] = [];
  const me = app.me;
  if (me?.pubkey) rows.push({ pubkey: me.pubkey, displayName: me.displayName });
  const team = await query<{ admins?: NameRow[] }>('admins.list');
  rows.push(...(team?.admins ?? []));
  return rows;
}

export const names = new Names();

// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Human formatting for read-only action output (§6.6: no raw JSON or unnamed
 * hex in the simple view). Pure functions; OutputView.svelte renders them.
 */
import { HEX64, npubShort, shortHex } from './npub.ts';
import { m } from './paraglide/messages.js';
import { ago, formatBytes } from './utils.ts';

/** Labels for keys that appear across many actions (plain language). */
const LABELS: Record<string, () => string> = {
  pubkey: () => m.out_key_person(),
  pubkeys: () => m.out_key_people(),
  author: () => m.out_key_person(),
  owner: () => m.out_key_owner(),
  sha256: () => m.out_key_file(),
  size: () => m.out_key_size(),
  type: () => m.out_key_type(),
  createdAt: () => m.out_key_created(),
  created_at: () => m.out_key_created(),
  uploadedAt: () => m.out_key_uploaded(),
  updatedAt: () => m.out_key_updated(),
  expiresAt: () => m.out_key_expires(),
  firstSeen: () => m.out_key_first_seen(),
  lastSeen: () => m.out_key_last_seen(),
  usedBytes: () => m.out_key_used(),
  storageBytes: () => m.out_key_used(),
  quotaBytes: () => m.out_key_limit(),
  remainingBytes: () => m.out_key_remaining(),
  files: () => m.out_key_files(),
  displayName: () => m.out_key_name(),
  name: () => m.out_key_name(),
  roles: () => m.out_key_roles(),
  reason: () => m.out_key_reason(),
  status: () => m.out_key_status(),
  id: () => m.out_key_id(),
  '*': () => m.out_key_all(),
};

/** "uploadedAt" → "Uploaded at", "max_event_bytes" → "Max event bytes". */
export function humanizeKey(key: string): string {
  const known = LABELS[key];
  if (known) return known();
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const PERSON_KEY =
  /^(pubkeys?|authors?|owners?|by|reporters?|actors?|admins?|users?|members?|people|person|signer|subject|target)$|pubkeys?$/i;
const BYTES_KEY = /bytes$|^size$|^bytes$/i;
const TIME_KEY =
  /(At|_at|Time|_time|Date)$|^(at|time|timestamp|since|until|expires|firstSeen|lastSeen|created|updated|when)$/;
const MS_KEY = /(Ms|_ms|Millis)$/;
const SEC_KEY = /(Seconds|Secs|_s|Sec)$|^ttl$/i;
const DAYS_KEY = /Days$|_days$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const LONG_HEX = /^[0-9a-f]{32,}$/i;

export function isPersonKey(key: string | undefined): boolean {
  return !!key && PERSON_KEY.test(key);
}

/** Relative time for Unix seconds or ms, past ("2h ago") or future ("in 3d"). */
export function relTime(t: number, now = Date.now()): string {
  const ms = t < 1e12 ? t * 1000 : t;
  if (ms <= now) return ago(ms, now);
  const s = Math.round((ms - now) / 1000);
  if (s < 60) return m.out_in({ span: `${s}s` });
  const mins = Math.round(s / 60);
  if (mins < 60) return m.out_in({ span: `${mins}m` });
  const h = Math.round(mins / 60);
  if (h < 24) return m.out_in({ span: `${h}h` });
  return m.out_in({ span: `${Math.round(h / 24)}d` });
}

/** 250 → "250 ms", 90_000 → "1.5 min". */
export function formatDuration(ms: number): string {
  const abs = Math.abs(ms);
  const fmt = (v: number) => String(Number(v.toFixed(v >= 10 ? 0 : 1)));
  if (abs < 1000) return `${Math.round(ms)} ms`;
  if (abs < 60_000) return `${fmt(ms / 1000)} s`;
  if (abs < 3_600_000) return `${fmt(ms / 60_000)} min`;
  if (abs < 86_400_000) return `${fmt(ms / 3_600_000)} h`;
  return `${fmt(ms / 86_400_000)} d`;
}

/** A formatted leaf value. */
export type Cell =
  | { kind: 'text'; text: string }
  | { kind: 'empty'; text: string }
  | { kind: 'person'; pubkey: string; text: string }
  | { kind: 'id'; full: string; text: string };

export interface NameLookup {
  label(pubkey: string): string;
}

const plainNames: NameLookup = { label: (pk) => npubShort(pk) };

/** Format one scalar for the simple view. `key` is the field it came from. */
export function formatValue(
  key: string | undefined,
  value: unknown,
  names: NameLookup = plainNames,
  now = Date.now(),
): Cell {
  if (value === null || value === undefined || value === '') return { kind: 'empty', text: '—' };
  if (typeof value === 'boolean') return { kind: 'text', text: value ? m.out_yes() : m.out_no() };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { kind: 'empty', text: '—' };
    const k = key ?? '';
    if (BYTES_KEY.test(k)) return { kind: 'text', text: formatBytes(value) };
    if (TIME_KEY.test(k) && value > 1e9) return { kind: 'text', text: relTime(value, now) };
    if (MS_KEY.test(k)) return { kind: 'text', text: formatDuration(value) };
    if (SEC_KEY.test(k)) return { kind: 'text', text: formatDuration(value * 1000) };
    if (DAYS_KEY.test(k)) return { kind: 'text', text: m.out_days({ count: value }) };
    return { kind: 'text', text: value.toLocaleString('en') };
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if ((HEX64.test(s) && isPersonKey(key)) || /^npub1[02-9ac-hj-np-z]{58}$/.test(s))
      return { kind: 'person', pubkey: s, text: names.label(s) };
    if (LONG_HEX.test(s)) return { kind: 'id', full: s, text: shortHex(s) };
    if (ISO_DATE.test(s)) {
      const t = Date.parse(s);
      if (Number.isFinite(t)) return { kind: 'text', text: relTime(t, now) };
    }
    return { kind: 'text', text: s };
  }
  // bigint/symbol/function: not produced by JSON, but keep it safe
  return { kind: 'text', text: String(value) };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Visible entries of an object (skips undefined). */
export function entriesOf(o: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(o).filter(([, v]) => v !== undefined);
}

/** A heading for a list item card (name/title/label/person), if any. */
export function itemTitle(o: Record<string, unknown>, names: NameLookup = plainNames): string {
  for (const k of ['displayName', 'name', 'title', 'label']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const pk = o.pubkey;
  if (typeof pk === 'string' && HEX64.test(pk)) return names.label(pk);
  return '';
}

/** Keys already shown as the card heading. */
export function titleKey(o: Record<string, unknown>): string | undefined {
  for (const k of ['displayName', 'name', 'title', 'label'])
    if (typeof o[k] === 'string' && (o[k] as string).trim()) return k;
  return undefined;
}

/** Default page size for lists in the output view. */
export const PAGE = 50;

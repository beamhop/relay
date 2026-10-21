// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Home attention cards. Preferred source: the experience module's ranked,
 * batched inbox (`experience.inbox` + approve/snooze/dismiss actions, state
 * kept per admin on the server). Fallback when that module is absent: raw
 * `/cards` with per-device snoozes in localStorage.
 */
import type { ApiClient } from './api/client.ts';
import type { AttentionCard, CatalogAction } from './api/types.ts';

export const INBOX = 'experience.inbox';
export const APPROVE = 'experience.approve-card';
export const SNOOZE = 'experience.snooze-card';
export const DISMISS = 'experience.dismiss-card';

export interface InboxCard {
  key: string;
  relayId: string | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  technical?: string;
  count: number;
  createdAt: number;
  primary?: { label: string; actionId: string; inputs: unknown[] };
  playbook?: string;
}

export interface HomeCard {
  key: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  technical?: string;
  count: number;
  playbook?: string;
  /** Label of the approve action, when the admin may run it. */
  primaryLabel?: string;
  /** How approval works: through the inbox (server-side) or by running the card's action directly. */
  approve?: { actionId: string; input: Record<string, unknown> };
  source: 'inbox' | 'cards';
}

const KEY = 'beamhop.snoozed';
export const SNOOZE_SECONDS = 24 * 3600;

function read(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

function write(s: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** Key that survives batching changes (`batch:` cards are keyed by their size too). */
export function cardKey(c: AttentionCard): string {
  return c.batchKey ? `batch:${c.batchKey}:${c.count}` : c.id;
}

export function snoozeLocal(key: string, seconds = SNOOZE_SECONDS, now = Date.now()): void {
  const s = read();
  s[key] = Math.floor(now / 1000) + seconds;
  write(s);
}

export function unsnoozeLocal(key: string): void {
  const s = read();
  delete s[key];
  write(s);
}

export function visibleLocal<T extends { key: string }>(cards: T[], now = Date.now()): T[] {
  const s = read();
  const t = Math.floor(now / 1000);
  let dirty = false;
  for (const [k, until] of Object.entries(s)) {
    if (until <= t) {
      delete s[k];
      dirty = true;
    }
  }
  if (dirty) write(s);
  return cards.filter((c) => !((s[c.key] ?? 0) > t));
}

export function fromInbox(c: InboxCard, catalog: CatalogAction[]): HomeCard {
  const h: HomeCard = {
    key: c.key,
    severity: c.severity,
    title: c.title,
    body: c.body,
    count: c.count,
    source: 'inbox',
  };
  if (c.technical) h.technical = c.technical;
  if (c.playbook) h.playbook = c.playbook;
  const target = c.primary && catalog.find((a) => a.id === c.primary?.actionId);
  if (c.primary && target?.allowed !== false && catalog.some((a) => a.id === APPROVE)) {
    h.primaryLabel = c.primary.label;
    h.approve = { actionId: APPROVE, input: { key: c.key } };
  }
  return h;
}

export function fromCard(c: AttentionCard, catalog: CatalogAction[]): HomeCard {
  const h: HomeCard = {
    key: cardKey(c),
    severity: c.severity,
    title: c.title,
    body: c.body,
    count: c.count,
    source: 'cards',
  };
  if (c.technical) h.technical = c.technical;
  if (c.playbook) h.playbook = c.playbook;
  if (
    c.primary &&
    c.primaryAllowed !== false &&
    catalog.some((a) => a.id === c.primary?.actionId)
  ) {
    h.primaryLabel = c.primary.label;
    h.approve = {
      actionId: c.primary.actionId,
      input: (c.primary.input ?? {}) as Record<string, unknown>,
    };
  }
  return h;
}

export async function loadCards(
  api: ApiClient,
  catalog: CatalogAction[],
  relayId: string | null,
): Promise<HomeCard[]> {
  const inbox = catalog.find((a) => a.id === INBOX);
  if (inbox) {
    const r = await api.run<{ cards: InboxCard[] }>(INBOX, relayId ? { relayId } : {}, inbox.scope);
    return r.output.cards.map((c) => fromInbox(c, catalog));
  }
  const cards = await api.cards(!!relayId);
  return visibleLocal(cards.map((c) => fromCard(c, catalog)));
}

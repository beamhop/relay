// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Suggestions engine (§6.8, §6.9): every module's attention cards become one
 * ranked inbox per admin. Similar cards collapse into one (same relay + same
 * `batchKey`), and each admin can dismiss or snooze cards for themselves.
 *
 * Nothing here applies a change: approving a card runs its primary action
 * through the normal action path only when an admin explicitly asks for it.
 */
import { type AttentionCard, type Kernel, type Principal, type RelayId, can } from '@beamhop/core';
import { COL, SerialQueue, plural } from './util.ts';

export const SEVERITY_RANK: Record<AttentionCard['severity'], number> = {
  critical: 3,
  warning: 2,
  info: 1,
};

/** How long dismissed/approved state is remembered (cards that come back after this reappear). */
export const CARD_STATE_TTL = 30 * 86400;
/** Max member ids remembered per dismissed card. */
const MAX_MEMBERS = 500;

export interface CardAction {
  label: string;
  actionId: string;
  /** One input per batched member (length 1 for a single card). */
  inputs: unknown[];
}

/** A card as shown in the inbox: possibly a batch of several similar source cards. */
export interface InboxCard {
  /** Stable inbox key: `batch:<relay>:<batchKey>` or `card:<id>`. Used to approve/dismiss/snooze. */
  key: string;
  relayId: RelayId | null;
  severity: AttentionCard['severity'];
  title: string;
  body: string;
  technical?: string;
  /** Number of source cards collapsed into this one. */
  count: number;
  /** Source card ids. */
  members: string[];
  /** Card sources that contributed. */
  sources: string[];
  /** Oldest member creation time (unix seconds). */
  createdAt: number;
  /** Age in seconds at the time the inbox was built. */
  ageSeconds: number;
  primary?: CardAction;
  secondary?: CardAction;
  playbook?: string;
  /**
   * False when there is nothing to approve (no `primary` action): the card is
   * information only, so apps hide "approve" / swipe-right and offer dismiss instead.
   */
  approvable: boolean;
}

export interface CardStateEntry {
  state: 'dismissed' | 'snoozed' | 'approved';
  at: number;
  until?: number;
  /** Member ids at the time; a batch that gains new members shows up again. */
  members: string[];
}

export interface CardStateDoc {
  cards: Record<string, CardStateEntry>;
}

export interface Inbox {
  cards: InboxCard[];
  allClear: boolean;
  /** Plain one-liner for the top of Home. */
  message: string;
  counts: { critical: number; warning: number; info: number };
  /** Cards hidden for this admin (dismissed or snoozed). */
  hidden: { dismissed: number; snoozed: number };
  /** Card sources that failed this time (their cards are missing). */
  failedSources: string[];
  generatedAt: number;
}

export function batchKeyOf(card: AttentionCard): string {
  return card.batchKey ? `batch:${card.relayId ?? '*'}:${card.batchKey}` : `card:${card.id}`;
}

function sameAction(
  cards: AttentionCard[],
  pick: (c: AttentionCard) => AttentionCard['primary'],
): CardAction | undefined {
  const first = pick(cards[0]!);
  if (!first) return undefined;
  const all = cards.map(pick);
  if (all.some((a) => !a || a.actionId !== first.actionId)) return undefined;
  const label = cards.length > 1 ? `${first.label} (all ${cards.length})` : first.label;
  return { label, actionId: first.actionId, inputs: all.map((a) => a!.input) };
}

/** Collapse source cards (deduped by id) into inbox cards. Pure. */
export function batchCards(
  input: Array<{ source: string; card: AttentionCard }>,
  now: number,
): InboxCard[] {
  const seen = new Set<string>();
  const groups = new Map<string, Array<{ source: string; card: AttentionCard }>>();
  for (const item of input) {
    if (seen.has(item.card.id)) continue;
    seen.add(item.card.id);
    const k = batchKeyOf(item.card);
    let arr = groups.get(k);
    if (!arr) {
      arr = [];
      groups.set(k, arr);
    }
    arr.push(item);
  }
  const out: InboxCard[] = [];
  for (const [key, items] of groups) {
    const cards = items
      .map((i) => i.card)
      .sort(
        (a, b) =>
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.createdAt - b.createdAt,
      );
    const lead = cards[0]!;
    const n = cards.length;
    const createdAt = Math.min(...cards.map((c) => c.createdAt));
    const card: InboxCard = {
      key,
      relayId: lead.relayId,
      severity: lead.severity,
      title: n > 1 ? `${lead.title} (+${plural(n - 1, 'similar item')})` : lead.title,
      body:
        n > 1
          ? `${lead.body} ${plural(n, 'similar suggestion')} were grouped together.`
          : lead.body,
      count: n,
      members: cards.map((c) => c.id),
      sources: [...new Set(items.map((i) => i.source))],
      createdAt,
      ageSeconds: Math.max(0, now - createdAt),
      approvable: false,
    };
    const tech = [...new Set(cards.map((c) => c.technical).filter(Boolean))];
    if (tech.length) card.technical = tech.slice(0, 5).join('; ');
    const primary = sameAction(cards, (c) => c.primary);
    if (primary) {
      card.primary = primary;
      card.approvable = true;
    }
    const secondary = sameAction(cards, (c) => c.secondary);
    if (secondary) card.secondary = secondary;
    const playbook = cards.find((c) => c.playbook)?.playbook;
    if (playbook) card.playbook = playbook;
    out.push(card);
  }
  return rankCards(out);
}

/** Severity first, then the longest-waiting card, then bigger batches. */
export function rankCards(cards: InboxCard[]): InboxCard[] {
  return [...cards].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.createdAt - b.createdAt ||
      b.count - a.count ||
      a.key.localeCompare(b.key),
  );
}

/** Is the card hidden for this admin by a dismiss/snooze/approve entry? */
export function isHidden(card: InboxCard, entry: CardStateEntry | undefined, now: number): boolean {
  if (!entry) return false;
  if (entry.state === 'snoozed') return (entry.until ?? 0) > now;
  // Dismissed / approved: hidden until new members join the batch.
  const known = new Set(entry.members);
  return card.members.every((m) => known.has(m));
}

export class CardStateStore {
  private readonly queue = new SerialQueue();
  constructor(private readonly kernel: Kernel) {}

  async get(principalId: string): Promise<CardStateDoc> {
    const doc = await this.kernel.ports.docs.get<CardStateDoc>(COL.cardState, principalId);
    return doc ?? { cards: {} };
  }

  /** Set (or with `entry = null` clear) one card's state. Returns the previous entry. */
  update(
    principalId: string,
    key: string,
    entry: CardStateEntry | null,
  ): Promise<CardStateEntry | undefined> {
    return this.queue.run(async () => {
      const docs = this.kernel.ports.docs;
      const now = this.kernel.ports.clock.now();
      const doc = await this.get(principalId);
      const prev = doc.cards[key];
      if (entry) doc.cards[key] = { ...entry, members: entry.members.slice(0, MAX_MEMBERS) };
      else delete doc.cards[key];
      // Forget stale entries so the document stays small.
      for (const [k, e] of Object.entries(doc.cards)) {
        const expired = e.state === 'snoozed' ? (e.until ?? 0) <= now : now - e.at > CARD_STATE_TTL;
        if (expired) delete doc.cards[k];
      }
      await docs.put(COL.cardState, principalId, doc);
      return prev;
    });
  }

  idle(): Promise<unknown> {
    return this.queue.idle();
  }
}

export class SuggestionsEngine {
  readonly state: CardStateStore;

  constructor(private readonly kernel: Kernel) {
    this.state = new CardStateStore(kernel);
  }

  /** All cards from every source, batched and ranked (no per-admin filtering). */
  async collect(
    relayId: RelayId | null = null,
  ): Promise<{ cards: InboxCard[]; failedSources: string[] }> {
    const k = this.kernel;
    const scopes: Array<RelayId | null> = relayId
      ? [relayId]
      : [null, ...k.config().relays.map((r) => r.id)];
    const raw: Array<{ source: string; card: AttentionCard }> = [];
    const failed = new Set<string>();
    await Promise.all(
      k.cards.map(async (src) => {
        for (const scope of scopes) {
          try {
            for (const card of await src.cards(scope)) {
              if (relayId && card.relayId !== relayId) continue;
              raw.push({ source: src.id, card });
            }
          } catch (err) {
            failed.add(src.id);
            k.bus.emit('error', { source: `experience.cards:${src.id}`, message: String(err) });
          }
        }
      }),
    );
    // Deterministic order before dedupe (sources resolve concurrently).
    raw.sort((a, b) => a.source.localeCompare(b.source) || a.card.id.localeCompare(b.card.id));
    return { cards: batchCards(raw, k.ports.clock.now()), failedSources: [...failed].sort() };
  }

  /** The inbox for one admin: cards they may see, minus what they dismissed or snoozed. */
  async inbox(principal: Principal, relayId: RelayId | null = null): Promise<Inbox> {
    const now = this.kernel.ports.clock.now();
    const { cards, failedSources } = await this.collect(relayId);
    const state = await this.state.get(principal.id);
    const visible: InboxCard[] = [];
    const hidden = { dismissed: 0, snoozed: 0 };
    for (const c of cards) {
      if (!can(principal, 'relay.read', c.relayId)) continue;
      const entry = state.cards[c.key];
      if (isHidden(c, entry, now)) {
        if (entry?.state === 'snoozed') hidden.snoozed++;
        else hidden.dismissed++;
        continue;
      }
      visible.push(c);
    }
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const c of visible) counts[c.severity]++;
    const allClear = visible.length === 0;
    return {
      cards: visible,
      allClear,
      message: allClear
        ? 'All clear — nothing needs you right now.'
        : counts.critical > 0
          ? `${plural(counts.critical, 'urgent item')} and ${plural(visible.length - counts.critical, 'other')} waiting for you.`
          : `${plural(visible.length, 'thing')} to look at when you have a minute.`,
      counts,
      hidden,
      failedSources,
      generatedAt: now,
    };
  }

  /** Find a card (visible or not) by inbox key, or by any member card id. */
  async find(key: string, relayId: RelayId | null = null): Promise<InboxCard | undefined> {
    const { cards } = await this.collect(relayId);
    return cards.find((c) => c.key === key) ?? cards.find((c) => c.members.includes(key));
  }
}

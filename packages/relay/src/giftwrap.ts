// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NIP-17 / NIP-59 private messages: gift wraps are only ever served to the
 * recipient, i.e. a connection authenticated (NIP-42) as a pubkey named in the
 * wrap's `p` tag. Asking for gift wraps without signing in gets
 * `CLOSED auth-required:` (the challenge is sent on connect), which is what
 * inbox relays (NIP-17 kind 10050) are expected to do.
 *
 * Publishing gift wraps stays open: the outer key is random by design.
 */
import type { Filter, NostrEvent } from '@beamhop/core';
import type { Audience, FilterCheck, RelayExtension } from './extensions.ts';

/** 1059 gift wrap (NIP-59), 1060 legacy/alt wrap, 21059 ephemeral gift wrap. */
export const GIFT_WRAP_KINDS: ReadonlySet<number> = new Set([1059, 1060, 21059]);
/** NIP-17 DM relay list (replaceable, stored normally). */
export const DM_RELAYS_KIND = 10050;

export function isGiftWrap(event: Pick<NostrEvent, 'kind'>): boolean {
  return GIFT_WRAP_KINDS.has(event.kind);
}

function recipientAudience(event: NostrEvent): Audience {
  const recipients = new Set<string>();
  for (const t of event.tags) if (t[0] === 'p' && t[1]) recipients.add(t[1]);
  return (authed) => {
    for (const pk of authed) if (recipients.has(pk)) return true;
    return false;
  };
}

/**
 * Rewrite filters that ask for gift wraps so they only reach wraps addressed to
 * an authenticated pubkey. Filters without `kinds` are left alone; any wrap they
 * would match is dropped at delivery by the audience check.
 */
export function giftWrapFilters(filters: Filter[], authed: ReadonlySet<string>): FilterCheck {
  const out: Filter[] = [];
  for (const f of filters) {
    const kinds = f.kinds;
    if (!kinds || !kinds.some((k) => GIFT_WRAP_KINDS.has(k))) {
      out.push(f);
      continue;
    }
    if (authed.size === 0) {
      return {
        ok: false,
        prefix: 'auth-required',
        message: 'please sign in to read your private messages',
      };
    }
    const gift = kinds.filter((k) => GIFT_WRAP_KINDS.has(k));
    const rest = kinds.filter((k) => !GIFT_WRAP_KINDS.has(k));
    const asked = f['#p'];
    const p = asked ? asked.filter((pk) => authed.has(pk)) : [...authed];
    if (p.length === 0 && rest.length === 0) {
      return {
        ok: false,
        prefix: 'restricted',
        message: 'you can only read private messages addressed to you',
      };
    }
    if (p.length > 0) out.push({ ...f, kinds: gift, '#p': p });
    if (rest.length > 0) out.push({ ...f, kinds: rest });
  }
  return { ok: true, filters: out };
}

export const giftWrapExtension: RelayExtension = {
  id: 'nip59',
  audience(_relayId, event) {
    return isGiftWrap(event) ? recipientAudience(event) : null;
  },
  filters(_relayId, filters, authed) {
    return giftWrapFilters(filters, authed);
  },
};
